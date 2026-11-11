import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installTwin } from './twin/install.mjs';
import { fixture } from './twin/near-twin.mjs';
import { attestModel } from '../src/attest.mjs';
import { boot, assertEnvelope, CONTRACT } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let env, tw;
afterEach(async () => { await env?.close(); env = null; await tw?.restore(); tw = null; });
const att = async (script) => { tw = await installTwin({ script, realSigner: true }); return attestModel(fixture.model, ''); };
const failedIds = (a) => a.checks.filter((c) => !c.pass && !c.informational).map((c) => `${c.scope}:${c.id}`);

describe('review item 1: strict signature model prefix', () => {
  test('missing model prefix FAILS sig_model', async () => {
    env = await boot({ script: { signature: 'no_model_prefix' } });
    const r = await env.post('/api/analyze', { text: CONTRACT });
    assert.equal(r.json.verified, false);
    assert.ok(r.json.signature.checks.some((c) => c.id === 'sig_model' && !c.pass));
  });
});

describe('review item 2: signer encoding in report_data', () => {
  test('over-long signing_address (prefix collides with the quoted key) fails rd_signer', async () => {
    const a = await att({ mutate: (r) => { r.model_attestations[0].signing_address += 'ab'; } });
    assert.equal(a.verified, false);
    assert.ok(failedIds(a).includes('model:rd_signer'));
  });
  test('non-hex / short signer fails rd_signer', async () => {
    const a = await att({ mutate: (r) => { r.model_attestations[0].signing_address = '0x1234'; } });
    assert.ok(failedIds(a).includes('model:rd_signer'));
  });
});

describe('review item 3: NVIDIA token verification', () => {
  test('happy path verifies signed JWTs with >=1 GPU', async () => {
    const a = await att({});
    assert.deepEqual(failedIds(a), []);
    assert.equal(a.gpuCount, 8);
  });
  test('tampered JWT signature fails gpu', async () => {
    const a = await att({ nras: 'bad_jwt_sig' });
    assert.equal(a.verified, false);
    assert.match(a.checks.find((c) => c.id === 'gpu' && !c.pass).detail, /signature invalid/);
  });
  test('unknown signing key fails gpu', async () => {
    const a = await att({ jwks: 'empty' });
    assert.match(a.checks.find((c) => c.id === 'gpu' && !c.pass).detail, /unknown key/);
  });
  test('zero GPUs fails', async () => {
    const a = await att({ nras: 'no_gpus' });
    assert.equal(a.verified, false);
    assert.ok(failedIds(a).includes('gpu:gpu'));
  });
  test('wrong nonce binding (eat_nonce) fails', async () => {
    tw = await installTwin({ realSigner: true });
    const { setDeps } = await import('../src/attest.mjs');
    setDeps({ newNonce: () => 'cd'.repeat(32) });
    const a = await attestModel(fixture.model, '');
    assert.ok(failedIds(a).includes('gpu:gpu_nonce') || failedIds(a).includes('gpu:gpu'));
  });
  test('expired token fails', async () => {
    tw = await installTwin({ realSigner: true });
    const { setDeps } = await import('../src/attest.mjs');
    setDeps({ nowSec: () => fixture.recordedAt + 3 * 3600 });
    const a = await attestModel(fixture.model, '');
    assert.match(a.checks.find((c) => c.id === 'gpu').detail, /expired/);
  });
});

describe('review item 7: informational pinning check', () => {
  test('not configured: shown, flagged informational, does not affect verified', async () => {
    delete process.env.EXPECTED_COMPOSE_HASH;
    const a = await att({});
    const c = a.checks.find((x) => x.id === 'measurement_pinning');
    assert.equal(c.scope, 'info'); assert.equal(c.informational, true); assert.equal(c.pass, false);
    assert.match(c.detail, /not configured/);
    assert.equal(a.verified, true);
  });
  test('pinned to the right hash: pinned check passes; wrong hash fails verified', async () => {
    tw = await installTwin({ realSigner: true });
    process.env.EXPECTED_COMPOSE_HASH = 'a0e3c6f4f21a60ea3f5c96bc7ef319b03a184ca2049605399275fbcea74e8c5f';
    try {
      const ok = await attestModel(fixture.model, '');
      assert.match(ok.checks.find((x) => x.id === 'measurement_pinning').detail, /pinned ✓/);
      assert.equal(ok.verified, true);
      process.env.EXPECTED_COMPOSE_HASH = 'ff'.repeat(32);
      const bad = await attestModel(fixture.model, '');
      assert.equal(bad.verified, false);
      assert.ok(failedIds(bad).includes('model:compose_pinned'));
    } finally { delete process.env.EXPECTED_COMPOSE_HASH; }
  });
});

const rawReq = (base, { method = 'GET', p = '/api/health', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  const r = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => {
    let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json, raw: b }); });
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});

describe('review item 6: local CSRF / DNS rebinding', () => {
  const body = () => JSON.stringify({ text: CONTRACT });
  test('POST without application/json is 415 and never reaches NEAR', async () => {
    env = await boot();
    const r = await rawReq(env.base, { method: 'POST', p: '/api/analyze', headers: { 'Content-Type': 'text/plain' }, body: body() });
    assertEnvelope(assert, r, 'UNSUPPORTED_MEDIA_TYPE', 415, false);
    const r2 = await rawReq(env.base, { method: 'POST', p: '/api/analyze', body: body() });
    assert.equal(r2.status, 415);
    assert.equal(env.twin.chatRequests, 0); assert.equal(env.twin.requests.length, 0);
  });
  test('foreign Host header (DNS rebinding) is 403 BAD_ORIGIN', async () => {
    env = await boot();
    for (const p of ['/api/health', '/']) assertEnvelope(assert, await rawReq(env.base, { p, headers: { Host: 'evil.example:80' } }), 'BAD_ORIGIN', 403, false);
    assertEnvelope(assert, await rawReq(env.base, { method: 'POST', p: '/api/analyze', headers: { Host: 'evil.example', 'Content-Type': 'application/json' }, body: body() }), 'BAD_ORIGIN', 403, false);
    assert.equal(env.twin.chatRequests, 0);
  });
  test('cross-origin Origin is 403; same-origin and absent Origin are fine', async () => {
    env = await boot();
    const host = new URL(env.base).host;
    const post = (origin) => rawReq(env.base, { method: 'POST', p: '/api/analyze', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: body() });
    assertEnvelope(assert, await post('https://evil.example'), 'BAD_ORIGIN', 403, false);
    assertEnvelope(assert, await post('null'), 'BAD_ORIGIN', 403, false);
    assert.equal(env.twin.chatRequests, 0);
    assert.equal((await post(`http://${host}`)).status, 200);
    assert.equal((await post()).status, 200);
    assert.equal((await rawReq(env.base, { headers: { Host: `localhost:${new URL(env.base).port}` } })).status, 200);
  });
});

const runNode = (args, e) => spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...e }, encoding: 'utf8', timeout: 15000 });

describe('review items 4 and 5: env handling', () => {
  test('endpoint overrides are refused without ALLOW_ENDPOINT_OVERRIDE=1', () => {
    for (const v of ['NRAS_URL', 'PCCS_URL', 'NEAR_BASE_URL']) {
      const r = runNode(['-e', "import('./src/attest.mjs')"], { [v]: 'http://evil.example/x', SAFEREDLINE_ENV_FILE: '/nonexistent' });
      assert.notEqual(r.status, 0, v);
      assert.match(r.stderr, /Refusing endpoint override/);
    }
  });
  test('with ALLOW_ENDPOINT_OVERRIDE=1 /api/health carries a warning', async () => {
    const child = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', NRAS_URL: 'http://127.0.0.1:9/x', ALLOW_ENDPOINT_OVERRIDE: '1', SAFEREDLINE_ENV_FILE: '/nonexistent' } });
    try {
      const port = await new Promise((res, rej) => { let b = ''; setTimeout(() => rej(new Error(b)), 8000); child.stdout.on('data', (d) => { b += d; const m = b.match(/:(\d+)\n/); if (m) res(m[1]); }); });
      const j = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      assert.equal(j.mode, 'live');
      assert.match(j.warnings[0], /NRAS_URL/);
    } finally { child.kill(); }
  });
  test('health has no warnings by default', async () => {
    env = await boot();
    assert.deepEqual((await env.get('/api/health')).json.warnings, []);
  });
  test('.env is loaded before attest.mjs reads its config', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-')), '.env');
    fs.writeFileSync(f, 'ALLOW_ENDPOINT_OVERRIDE=1\nNEAR_BASE_URL=https://example.test/v1\n');
    const r = runNode(['-e', "import('./src/attest.mjs').then((m) => console.log(m.deps.baseUrl))"], { SAFEREDLINE_ENV_FILE: f, NEAR_BASE_URL: '', ALLOW_ENDPOINT_OVERRIDE: '' });
    assert.equal(r.stdout.trim(), 'https://example.test/v1', r.stderr);
  });
});

describe('review 3b: per-GPU claims', () => {
  test('gpuClaimProblems flags each bad claim, accepts the recorded real claims', async () => {
    const { gpuClaimProblems } = await import('../src/attest.mjs');
    const real = JSON.parse(Buffer.from(Object.values(fixture.nras)[0][1]['GPU-0'].split('.')[1], 'base64url'));
    assert.deepEqual(gpuClaimProblems(real), []);
    assert.deepEqual(gpuClaimProblems({ ...real, secboot: false }), ['secboot']);
    assert.deepEqual(gpuClaimProblems({ ...real, dbgstat: 'enabled' }), ['dbgstat']);
    assert.deepEqual(gpuClaimProblems({ ...real, measres: 'fail' }), ['measres']);
    assert.deepEqual(gpuClaimProblems({ ...real, 'x-nvidia-attestation-warning': 'old driver' }), ['attestation-warning']);
    assert.deepEqual(gpuClaimProblems({ ...real, 'x-nvidia-gpu-driver-rim-signature-verified': false }), ['x-nvidia-gpu-driver-rim-signature-verified']);
    assert.deepEqual(gpuClaimProblems({ ...real, 'x-nvidia-gpu-attestation-report-nonce-match': false }), ['report-nonce-match']);
  });
});

describe('review 8: TLS channel binding (gateway)', () => {
  const tls = (a) => a.checks.find((c) => c.id === 'tls_bound');
  // Twin evidence is "recorded" and plain-HTTP, so tls_bound is skipped there; force the live code path with a stubbed cert reader.
  const live = async (reader) => {
    tw = await installTwin({ realSigner: true });
    const { setDeps } = await import('../src/attest.mjs');
    setDeps({ evidence: 'live', getTlsFingerprint: reader });
    return attestModel(fixture.model, '');
  };
  test('twin: tls_bound is informational and says it was skipped (no overclaim)', async () => {
    const a = await att({});
    assert.equal(a.evidence, 'recorded');
    assert.equal(tls(a).informational, true); assert.equal(tls(a).pass, false);
    assert.equal(tls(a).detail, 'skipped — twin uses plain HTTP (recorded evidence)');
    assert.equal(a.verified, true);
  });
  test('live cert == attested fingerprint: tls_bound passes and counts toward verified', async () => {
    const a = await live(async () => fixture.tlsFingerprint);
    assert.equal(tls(a).pass, true); assert.equal(tls(a).scope, 'gateway'); assert.equal(tls(a).informational, undefined);
    assert.equal(a.evidence, 'live'); assert.equal(a.verified, true);
  });
  test('mismatching live certificate: tls_bound fails and fails verified (always enforced)', async () => {
    const a = await live(async () => 'ee'.repeat(32));
    assert.equal(tls(a).pass, false); assert.match(tls(a).detail, /≠ attested/);
    assert.equal(a.verified, false);
  });
  test('unreadable live certificate fails tls_bound (fail closed)', async () => {
    const a = await live(async () => { throw new Error('ECONNREFUSED'); });
    assert.match(tls(a).detail, /could not read/); assert.equal(a.verified, false);
  });
  test('tampered attested fingerprint breaks the quote binding (rd_signer)', async () => {
    const a = await att({ mutate: (r) => { r.gateway_attestation.tls_cert_fingerprint = 'ee'.repeat(32); } });
    assert.equal(a.verified, false);
    assert.ok(failedIds(a).includes('gateway:rd_signer'));
  });
  test('malformed fingerprint fails rd_signer', async () => {
    const a = await att({ mutate: (r) => { r.gateway_attestation.tls_cert_fingerprint = 'zz'; } });
    assert.ok(failedIds(a).includes('gateway:rd_signer'));
  });
});
