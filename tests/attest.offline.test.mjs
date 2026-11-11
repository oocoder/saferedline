import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installTwin } from './twin/install.mjs';
import { fixture } from './twin/near-twin.mjs';
import { attestModel, setDeps, deps } from '../src/attest.mjs';

let env;
const boot = async (script = {}) => { env = await installTwin({ script, realSigner: true }); };
const failed = (a) => a.checks.filter((c) => !c.pass && !c.informational).map((c) => `${c.scope}:${c.id}`);
const has = (a, id, scope) => a.checks.some((c) => c.id === id && (!scope || c.scope === scope) && !c.pass);
afterEach(async () => { await env?.restore(); env = null; });

describe('recorded real attestation, offline', () => {
  test('all checks pass and verified === true', async () => {
    await boot();
    const a = await attestModel(fixture.model, '');
    assert.deepEqual(failed(a), []);
    assert.equal(a.verified, true);
    assert.ok(a.checks.length >= 16, `only ${a.checks.length} checks`);
    assert.ok(a.checks.every((c) => ['gateway', 'model', 'gpu', 'signature', 'info'].includes(c.scope)));
    assert.equal(a.tcbStatus, 'UpToDate');
    assert.ok(a.signingAddresses.length >= 1);
    assert.ok(a.gpuCount > 0);
    assert.equal(a.nonce.length, 64);
  });

  test('nonce differing from the recorded one fails nonce_echo and rd_nonce (anti-replay)', async () => {
    await boot();
    setDeps({ newNonce: () => 'ab'.repeat(32) });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.verified, false);
    assert.ok(has(a, 'nonce_echo') && has(a, 'rd_nonce'));
    assert.ok(has(a, 'gpu'), 'NRAS token eat_nonce must not match either');
  });

  test('tampered app_compose fails compose', async () => {
    await boot({ attestation: 'tampered_compose' });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.verified, false);
    assert.ok(has(a, 'compose', 'model'));
  });

  test('flipped quote byte fails tdx_quote', async () => {
    await boot({ mutate: (r) => { const q = r.model_attestations[0].intel_quote; const i = q.length - 40; r.model_attestations[0].intel_quote = q.slice(0, i) + (q[i] === '0' ? '1' : '0') + q.slice(i + 1); } });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.verified, false);
    assert.ok(has(a, 'tdx_quote', 'model'));
  });

  test('dropped RTMR3 event fails rtmr3', async () => {
    await boot({ mutate: (r) => { const m = r.model_attestations[0]; const ev = typeof m.event_log === 'string' ? JSON.parse(m.event_log) : m.event_log; const i = ev.findIndex((e) => e.imr === 3); ev.splice(i, 1); m.event_log = typeof m.event_log === 'string' ? JSON.stringify(ev) : ev; } });
    const a = await attestModel(fixture.model, '');
    assert.ok(has(a, 'rtmr3', 'model'));
    assert.equal(a.verified, false);
  });

  test('regression #2: missing app_compose FAILS (no silent skip)', async () => {
    await boot({ mutate: (r) => { const m = r.model_attestations[0]; if (typeof m.info.tcb_info === 'string') { const o = JSON.parse(m.info.tcb_info); delete o.app_compose; m.info.tcb_info = JSON.stringify(o); } else delete m.info.tcb_info.app_compose; } });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.verified, false);
    assert.ok(has(a, 'compose', 'model'));
  });

  test('regression #4: missing gateway_attestation FAILS', async () => {
    await boot({ attestation: 'missing_gateway' });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.verified, false);
    assert.ok(has(a, 'gateway_present'));
  });

  test('regression #1: unparseable quote body fails td_parse and verified is false', async () => {
    await boot({ mutate: (r) => { r.model_attestations[0].intel_quote = 'deadbeef'; } });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.verified, false);
    assert.ok(has(a, 'td_parse', 'model') && has(a, 'tdx_quote', 'model'));
  });

  test('regression #3: every model instance is verified, all signers returned', async () => {
    await boot({ mutate: (r) => { const dup = structuredClone(r.model_attestations[0]); dup.signing_address = '0x' + '99'.repeat(20); r.model_attestations.push(dup); } });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.signingAddresses.length, 2);
    assert.equal(a.verified, false, 'second instance has a signer the quote does not bind');
    assert.ok(has(a, 'rd_signer', 'model'));
  });

  test('collateral 400 days after recording is rejected (expired)', async () => {
    await boot();
    setDeps({ nowSec: () => fixture.recordedAt + 400 * 86400 });
    const a = await attestModel(fixture.model, '');
    assert.ok(has(a, 'tdx_quote', 'model'));
    assert.equal(a.verified, false);
  });

  test('PCCS rejecting fails closed fast with a clear message, flagged unavailable', async () => {
    await boot();
    setDeps({ getCollateral: () => Promise.reject(new Error('ECONNREFUSED')), fallbackPccsUrl: null });
    const t0 = Date.now();
    const a = await attestModel(fixture.model, '');
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(a.verified, false);
    const c = a.checks.find((x) => x.id === 'tdx_quote' && !x.pass);
    assert.match(c.detail, /PCCS.*failing closed/);
    assert.ok(a.unavailable.includes('Intel PCCS'));
  });

  test('PCCS hanging is cut off by the timeout (#7)', async () => {
    await boot();
    setDeps({ getCollateral: () => new Promise(() => {}), fallbackPccsUrl: null, timeouts: { ...deps.timeouts, pccs: 200 } });
    const t0 = Date.now();
    const a = await attestModel(fixture.model, '');
    assert.ok(Date.now() - t0 < 1500);
    assert.ok(has(a, 'tdx_quote', 'model'));
    assert.match(a.checks.find((x) => x.id === 'tdx_quote' && !x.pass).detail, /PCCS/);
  });

  test('NRAS 503 fails gpu with a clear message (unavailable)', async () => {
    await boot({ nras: '503' });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.verified, false);
    assert.match(a.checks.find((c) => c.id === 'gpu' && !c.pass).detail, /NRAS unreachable — failing closed/);
    assert.ok(a.unavailable.includes('NVIDIA NRAS'));
  });

  test('NRAS bad shape fails closed, not a TypeError (#8)', async () => {
    await boot({ nras: 'bad_shape' });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.verified, false);
    assert.match(a.checks.find((c) => c.id === 'gpu' && !c.pass).detail, /unexpected response — failing closed/);
    assert.equal(a.unavailable.length, 0);
  });

  test('attestation report endpoint down throws ATTESTATION_UNAVAILABLE', async () => {
    await boot({ attestation: '503' });
    await assert.rejects(attestModel(fixture.model, ''), (e) => e.code === 'ATTESTATION_UNAVAILABLE' && e.status === 503);
  });
});
