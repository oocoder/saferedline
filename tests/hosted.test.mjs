import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, assertEnvelope, rawReq, CONTRACT } from './helpers.mjs';
import { makeLimiter } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = (id) => fs.readFileSync(path.join(ROOT, 'samples', `${id}.txt`), 'utf8');
const SAMPLE_IDS = ['sample_predatory_nda', 'sample_balanced_nda', 'sample_contractor_agreement'];
let env;
afterEach(async () => { await env?.close(); env = null; delete process.env.ALLOWED_HOSTS; });
const hosted = (limits = {}, extra = {}) => boot({ serverOpts: { hostedDemo: true, limits, ...extra } });
const J = { 'Content-Type': 'application/json' };

describe('HOSTED_DEMO: samples only', () => {
  test('health reports mode hosted-demo', async () => {
    env = await hosted();
    assert.equal((await env.get('/api/health')).json.mode, 'hosted-demo');
  });
  test('all three bundled samples are accepted (also with surrounding whitespace)', async () => {
    env = await hosted({ analyze: 10 });
    for (const id of SAMPLE_IDS) {
      const r = await env.post('/api/analyze', { text: `\n  ${sample(id)}  \n` });
      assert.equal(r.status, 200, id);
      assert.equal(r.json.verified, true);
    }
  });
  test('anything else is 403 SAMPLES_ONLY, contract never sent, no rate-limit slot consumed', async () => {
    env = await hosted({ analyze: 1 });
    for (const text of [CONTRACT, sample(SAMPLE_IDS[0]) + ' tweak', sample(SAMPLE_IDS[0]).slice(0, -5)]) {
      const r = await env.post('/api/analyze', { text });
      assertEnvelope(assert, r, 'SAMPLES_ONLY', 403, false);
      assert.equal(r.json.error.message, 'The hosted demo accepts the bundled fictional samples only. Run SafeRedline locally for real contracts.');
    }
    assert.equal(env.twin.chatRequests, 0);
    assert.equal(env.twin.requests.length, 0, 'not even an attestation fetch');
    assert.equal((await env.post('/api/analyze', { text: sample(SAMPLE_IDS[1]) })).status, 200, 'limit untouched by rejected requests');
  });
  test('/api/ask is samples-only too', async () => {
    env = await hosted();
    assertEnvelope(assert, await env.post('/api/ask', { text: CONTRACT, question: 'q?' }), 'SAMPLES_ONLY', 403, false);
    const ok = await env.post('/api/ask', { text: sample(SAMPLE_IDS[0]), question: 'What is the term?' });
    assert.equal(ok.status, 200);
  });
  test('non-hosted mode still accepts arbitrary text', async () => {
    env = await boot();
    assert.equal((await env.post('/api/analyze', { text: CONTRACT })).status, 200);
  });
});

describe('HOSTED_DEMO: rate limits', () => {
  test('per-IP analyze limit: 429 RATE_LIMITED with Retry-After, before any NEAR traffic', async () => {
    env = await hosted({ analyze: 2 });
    const text = sample(SAMPLE_IDS[1]);
    assert.equal((await env.post('/api/analyze', { text })).status, 200);
    assert.equal((await env.post('/api/analyze', { text })).status, 200);
    const before = env.twin.requests.length;
    const r = await env.post('/api/analyze', { text });
    assertEnvelope(assert, r, 'RATE_LIMITED', 429, false);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal(env.twin.requests.length, before);
  });
  test('asks have their own per-IP budget', async () => {
    env = await hosted({ analyze: 1, ask: 1 });
    const text = sample(SAMPLE_IDS[0]);
    assert.equal((await env.post('/api/analyze', { text })).status, 200);
    assert.equal((await env.post('/api/ask', { text, question: 'a?' })).status, 200);
    assertEnvelope(assert, await env.post('/api/ask', { text, question: 'b?' }), 'RATE_LIMITED', 429, false);
  });
  test('global daily cap applies across IPs', async () => {
    env = await hosted({ analyze: 100, daily: 2 }, { trustProxy: true });
    const body = JSON.stringify({ text: sample(SAMPLE_IDS[1]) });
    const go = (ip) => rawReq(env.base, { method: 'POST', p: '/api/analyze', headers: { ...J, 'X-Forwarded-For': ip }, body });
    assert.equal((await go('1.1.1.1')).status, 200);
    assert.equal((await go('2.2.2.2')).status, 200);
    const r = await go('3.3.3.3');
    assertEnvelope(assert, r, 'RATE_LIMITED', 429, false);
    assert.match(r.json.error.message, /daily/);
  });
  test('trustProxy keys the limit on the right-most X-Forwarded-For; without it the header is ignored', async () => {
    env = await hosted({ analyze: 1 }, { trustProxy: true });
    const body = JSON.stringify({ text: sample(SAMPLE_IDS[1]) });
    const go = (xff) => rawReq(env.base, { method: 'POST', p: '/api/analyze', headers: { ...J, 'X-Forwarded-For': xff }, body });
    assert.equal((await go('9.9.9.9, 1.1.1.1')).status, 200);
    assert.equal((await go('8.8.8.8, 2.2.2.2')).status, 200, 'different client behind the proxy');
    assert.equal((await go('7.7.7.7, 1.1.1.1')).status, 429, 'spoofed left entry does not reset the budget');
    await env.close();
    env = await hosted({ analyze: 1 });
    assert.equal((await go('1.1.1.1')).status, 200);
    assert.equal((await go('2.2.2.2')).status, 429, 'XFF ignored when not behind a trusted proxy');
  });
  test('limiter unit: window expiry and day rollover (in-memory, injectable clock)', () => {
    let t = Date.UTC(2026, 10, 14, 23, 59, 0);
    const lim = makeLimiter({ window: 1000, analyze: 1, ask: 1, daily: 2, now: () => t });
    lim.check('ip', 'analyze');
    assert.throws(() => lim.check('ip', 'analyze'), (e) => e.code === 'RATE_LIMITED' && e.status === 429 && e.retryAfter >= 1);
    t += 1001; lim.check('ip', 'analyze');                       // window expired
    assert.throws(() => lim.check('other', 'analyze'), /daily/);   // daily cap of 2 reached
    t += 2 * 60 * 1000; lim.check('other', 'analyze');            // next UTC day resets the counter
  });
});

describe('HOSTED_DEMO: host allowlist', () => {
  test('public Host accepted only when listed in ALLOWED_HOSTS; foreign Host 403; https origin of allowed host ok', async () => {
    process.env.ALLOWED_HOSTS = 'demo.example.org';
    env = await hosted();
    const body = JSON.stringify({ text: sample(SAMPLE_IDS[1]) });
    assert.equal((await rawReq(env.base, { headers: { Host: 'demo.example.org' } })).status, 200);
    assertEnvelope(assert, await rawReq(env.base, { headers: { Host: 'other.example.org' } }), 'BAD_ORIGIN', 403, false);
    const post = (origin) => rawReq(env.base, { method: 'POST', p: '/api/analyze', headers: { ...J, Host: 'demo.example.org', Origin: origin }, body });
    assert.equal((await post('https://demo.example.org')).status, 200);
    assertEnvelope(assert, await post('https://evil.example.org'), 'BAD_ORIGIN', 403, false);
  });
});

describe('HOSTED_DEMO: bind policy (process)', () => {
  const run = (env2) => spawnSync(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', SAFEREDLINE_ENV_FILE: '/nonexistent', ...env2 }, encoding: 'utf8', timeout: 8000 });
  test('non-loopback HOST without HOSTED_DEMO=1 is refused', () => {
    const r = run({ HOST: '0.0.0.0', HOSTED_DEMO: '' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /loopback-only/);
  });
  test('HOSTED_DEMO on a public bind requires ALLOWED_HOSTS', () => {
    const r = run({ HOST: '0.0.0.0', HOSTED_DEMO: '1', ALLOWED_HOSTS: '' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /ALLOWED_HOSTS/);
  });
  test('HOSTED_DEMO with explicit HOST=0.0.0.0 + ALLOWED_HOSTS starts and reports hosted-demo; unset HOST stays on loopback', async () => {
    for (const [env2, expectBind] of [[{ HOST: '0.0.0.0', ALLOWED_HOSTS: 'demo.example.org' }, '0.0.0.0'], [{ HOST: '' }, '127.0.0.1']]) {
      const child = spawn(process.execPath, ['scripts/twin.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', SAFEREDLINE_ENV_FILE: '/nonexistent', SAFEREDLINE_TWIN: '1', HOSTED_DEMO: '1', ...env2 } });
      try {
        const port = await new Promise((res, rej) => { let b = ''; setTimeout(() => rej(new Error(b)), 8000); child.stdout.on('data', (d) => { b += d; const m = b.match(/http:\/\/[\d.]+:(\d+)/); if (m) res(m[1]); }); });
        const r = await rawReq(`http://127.0.0.1:${port}`, { headers: env2.ALLOWED_HOSTS ? { Host: 'demo.example.org' } : {} });
        assert.equal(r.json.mode, 'hosted-demo');
        assert.equal(r.json.bind, expectBind);
      } finally { child.kill(); }
    }
  });
});
