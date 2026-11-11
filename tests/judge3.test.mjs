import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { boot, assertEnvelope, CONTRACT } from './helpers.mjs';
import { isRealKey } from '../src/attest.mjs';
import { keyConfigured, setNearDeps } from '../src/near.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let env;
afterEach(async () => { await env?.close(); env = null; });

describe('placeholder / missing key', () => {
  test('isRealKey', () => {
    for (const bad of ['', undefined, null, 'abc', 'sk-your-key-here', 'sk-your-key', 'SK-x']) assert.equal(isRealKey(bad), false, String(bad));
    assert.equal(isRealKey('sk-abc123'), true);
  });
  test('placeholder key: analyze returns NO_API_KEY and nothing is attested or sent', async () => {
    env = await boot({ apiKey: 'sk-your-key-here' });
    assert.equal(keyConfigured(), false);
    assertEnvelope(assert, await env.post('/api/analyze', { text: CONTRACT }), 'NO_API_KEY', 503, false);
    assert.equal(env.twin.requests.length, 0);
  });
  test('.env.example ships an empty key', () => {
    assert.match(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'), /^NEAR_API_KEY=$/m);
  });
  test('startup log and health say the placeholder is not configured (live mode)', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-')), '.env');
    fs.writeFileSync(f, 'NEAR_API_KEY=sk-your-key-here\n');
    const r = spawnSync(process.execPath, ['-e', "import('./src/server.mjs').then(async (m)=>{const near=await import('./src/near.mjs');console.log(near.keyConfigured())})"], { cwd: ROOT, env: { ...process.env, SAFEREDLINE_ENV_FILE: f, NEAR_API_KEY: '' }, encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'false', r.stderr);
  });
});

describe('401 mapping', () => {
  test('chat 401 -> NEAR_AUTH with the check-your-key message', async () => {
    env = await boot({ script: { chat: '401' } });
    const r = await env.post('/api/analyze', { text: CONTRACT });
    assertEnvelope(assert, r, 'NEAR_AUTH', 502, true);
    assert.equal(r.json.error.message, 'NEAR AI Cloud rejected the API key (401). Check NEAR_API_KEY.');
  });
  test('attestation 401 -> NEAR_AUTH (not ATTESTATION_UNAVAILABLE), contract not sent', async () => {
    env = await boot({ script: { attestation: '401' } });
    const r = await env.post('/api/analyze', { text: CONTRACT });
    assertEnvelope(assert, r, 'NEAR_AUTH', 502, false);
    assert.match(r.json.error.message, /Check NEAR_API_KEY/);
    assert.equal(env.twin.chatRequests, 0);
    assertEnvelope(assert, await env.get('/api/attest'), 'NEAR_AUTH', 502, false);
  });
});

describe('twin honesty', () => {
  test('analyze carries evidence=recorded, skipped tls note, twinSignerNote', async () => {
    env = await boot();
    const r = await env.post('/api/analyze', { text: CONTRACT });
    assert.equal(r.json.attestation.evidence, 'recorded');
    assert.equal(r.json.twinSignerNote, 'Twin signs responses with a local test key; live mode requires the attested enclave key.');
    assert.match(r.json.channel.note, /skipped — twin uses plain HTTP \(recorded evidence\)/);
    assert.equal(r.json.channel.tlsPinned, false);
    const a = await env.post('/api/ask', { text: CONTRACT, question: 'q?' });
    assert.ok(a.json.twinSignerNote);
  });
});

describe('verify_tee.mjs never prints a stack trace', () => {
  const run = (args, e) => spawnSync(process.execPath, ['scripts/verify_tee.mjs', ...args], { cwd: ROOT, env: { ...process.env, SAFEREDLINE_ENV_FILE: '/nonexistent', ALLOW_ENDPOINT_OVERRIDE: '1', NEAR_BASE_URL: 'http://127.0.0.1:9/v1', ...e }, encoding: 'utf8', timeout: 20000 });
  test('unreachable NEAR: FAILED line, Verified: false, exit 1, no stack', () => {
    const r = run(['--attest-only']);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /FAILED \S+: /);
    assert.match(r.stdout, /Verified: +false/);
    assert.doesNotMatch(r.stdout + r.stderr, /\n\s+at .*\(.*:\d+:\d+\)|node:internal/);
  });
  test('--json: stdout is exactly one valid JSON document with ok:false and error {code,message}', () => {
    const r = run(['--json']);
    assert.equal(r.status, 1);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(typeof j.error.code, 'string'); assert.equal(typeof j.error.message, 'string');
    assert.doesNotMatch(r.stderr, /node:internal/);
  });
});
