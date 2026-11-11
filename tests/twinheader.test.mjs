import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, assertEnvelope, rawReq, CONTRACT } from './helpers.mjs';

let env;
afterEach(async () => { await env?.close(); env = null; });
const body = JSON.stringify({ text: CONTRACT });
const go = (h, headers = {}) => rawReq(env.base, { method: 'POST', p: '/api/analyze', headers: { 'Content-Type': 'application/json', ...(h ? { 'X-Twin-Script': h } : {}), ...headers }, body });

describe('X-Twin-Script (twin mode only)', () => {
  test('tampered_res and wrong_signer give verified:false, ok verifies', async () => {
    env = await boot();
    assert.equal((await go('tampered_res')).json.verified, false);
    assert.equal((await go('wrong_signer')).json.verified, false);
    assert.equal((await go('ok')).json.verified, true);
    assert.equal((await go()).json.verified, true, 'no header: default behaviour, nothing leaked from earlier requests');
  });
  test('attestation_failed: ATTESTATION_FAILED and the chat endpoint is never hit', async () => {
    env = await boot();
    const r = await go('attestation_failed');
    assertEnvelope(assert, { ...r, headers: r.headers }, 'ATTESTATION_FAILED', 502, false);
    assert.equal(env.twin.chatRequests, 0);
  });
  test('header overrides the process-wide TWIN_SCRIPT for that request only', async () => {
    env = await boot({ script: { signature: 'tampered_res' } });
    assert.equal((await go()).json.verified, false);
    assert.equal((await go('ok')).json.verified, true);
    assert.equal((await go()).json.verified, false, 'global script untouched');
  });
  test('concurrent requests with different headers do not interfere', async () => {
    env = await boot();
    const names = ['ok', 'tampered_res', 'ok', 'wrong_signer', 'tampered_res', 'ok'];
    const rs = await Promise.all(names.map((n) => go(n)));
    assert.deepEqual(rs.map((r) => r.json.verified), names.map((n) => n === 'ok'));
  });
  test('names outside the allowlist are rejected (400), case-insensitive for allowed ones', async () => {
    env = await boot();
    for (const bad of ['near_auth', 'bogus', 'ok,tampered_res', '__proto__']) assert.equal((await go(bad)).status, 400, bad);
    assert.equal((await go('TAMPERED_RES')).json.verified, false);
  });
  test('also applies to /api/ask and /api/attest', async () => {
    env = await boot();
    const ask = await rawReq(env.base, { method: 'POST', p: '/api/ask', headers: { 'Content-Type': 'application/json', 'X-Twin-Script': 'tampered_res' }, body: JSON.stringify({ text: CONTRACT, question: 'q?' }) });
    assert.equal(ask.json.verified, false);
    const att = await rawReq(env.base, { p: '/api/attest', headers: { 'X-Twin-Script': 'attestation_failed' } });
    assert.equal(att.json.verified, false);
  });
});

describe('X-Twin-Script is ignored outside twin mode', () => {
  test('live mode: header has no effect (even an attack name, even an invalid one)', async () => {
    env = await boot({ serverOpts: { mode: 'live' } }); // twin backend underneath, but the server is in live mode
    for (const h of ['tampered_res', 'wrong_signer', 'attestation_failed', 'bogus']) {
      const r = await go(h);
      assert.equal(r.status, 200, h);
      assert.equal(r.json.verified, true, `${h} must not change anything in live mode`);
    }
    assert.equal((await rawReq(env.base, { headers: { 'X-Twin-Script': 'bogus' } })).json.mode, 'live');
  });
  test('hosted-demo mode: header ignored', async () => {
    env = await boot({ serverOpts: { hostedDemo: true } });
    const sample = (await env.get('/api/samples')).json[1].text;
    const r = await rawReq(env.base, { method: 'POST', p: '/api/analyze', headers: { 'Content-Type': 'application/json', 'X-Twin-Script': 'tampered_res' }, body: JSON.stringify({ text: sample }) });
    assert.equal(r.status, 200);
    assert.equal(r.json.verified, true);
    const bogus = await rawReq(env.base, { method: 'POST', p: '/api/analyze', headers: { 'Content-Type': 'application/json', 'X-Twin-Script': 'bogus' }, body: JSON.stringify({ text: sample }) });
    assert.equal(bogus.status, 200);
  });
});
