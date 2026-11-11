import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, assertEnvelope, CONTRACT } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let env;
afterEach(async () => { await env?.close(); env = null; });

describe('HTTP surface', () => {
  test('headers: no-store, CSP, nosniff on every response', async () => {
    env = await boot();
    for (const p of ['/api/health', '/api/samples', '/', '/nope']) {
      const r = await env.get(p);
      assert.match(r.headers.get('cache-control'), /no-store/, p);
      assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/, p);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
  });
  test('health shape', async () => {
    env = await boot();
    const { json } = await env.get('/api/health');
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'twin');
    assert.equal(json.persistence, 'none');
    assert.equal(json.apiKeyConfigured, false, 'twin never reports its fake key as a real one');
    assert.equal(json.twinFakeKey, true);
    assert.equal(json.bind, '127.0.0.1');
    assert.equal(typeof json.version, 'string');
    assert.equal(typeof json.model, 'string');
  });
  test('samples: ordered predatory, balanced, contractor with non-ASCII', async () => {
    env = await boot();
    const { json } = await env.get('/api/samples');
    assert.deepEqual(json.map((s) => s.id), ['sample_predatory_nda', 'sample_balanced_nda', 'sample_contractor_agreement']);
    assert.deepEqual(json.map((s) => s.riskHint), ['High', 'Low', 'High']);
    for (const s of json) { assert.ok(s.title && s.text.length > 200); assert.ok(s.text.length >= 50); }
    assert.match(json[2].text, /[“”—§]/);
  });
  test('index served even if public/index.html is absent or present', async () => {
    env = await boot();
    const r = await env.get('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
  });
  test('HEAD works for GET routes (no body)', async () => {
    env = await boot();
    for (const p of ['/', '/api/health', '/api/samples']) {
      const res = await fetch(env.base + p, { method: 'HEAD' });
      assert.equal(res.status, 200, p);
      assert.equal(await res.text(), '');
      assert.match(res.headers.get('cache-control'), /no-store/);
    }
    assert.equal((await fetch(env.base + '/api/analyze', { method: 'HEAD' })).status, 404);
  });
  test('error envelope: input validation and routing', async () => {
    env = await boot();
    assertEnvelope(assert, await env.post('/api/analyze', { text: 'short' }), 'BAD_INPUT', 400, false);
    assertEnvelope(assert, await env.post('/api/analyze', {}), 'BAD_INPUT', 400, false);
    assertEnvelope(assert, await env.post('/api/analyze', '{not json'), 'BAD_INPUT', 400, false);
    assertEnvelope(assert, await env.post('/api/analyze', { text: 'x'.repeat(600 * 1024) }), 'TOO_LARGE', 413, false);
    assertEnvelope(assert, await env.post('/api/ask', { text: CONTRACT }), 'BAD_INPUT', 400, false);
    assertEnvelope(assert, await env.post('/api/ask', { text: CONTRACT, question: 'q'.repeat(1001) }), 'BAD_INPUT', 400, false);
    assertEnvelope(assert, await env.get('/api/nope'), 'NOT_FOUND', 404, false);
    assert.equal(env.twin.chatRequests, 0);
  });
});

describe('process', () => {
  test('npm run twin entry binds 127.0.0.1 by default and importing server.mjs does not listen (#19, #20)', async () => {
    const child = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', SAFEREDLINE_TWIN: '1', TWIN_SCRIPT: 'ok', HOST: '' } });
    try {
      const url = await new Promise((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error('server did not start: ' + buf)), 10000);
        child.stdout.on('data', (d) => { buf += d; const m = buf.match(/http:\/\/([\d.]+):(\d+)/); if (m) { clearTimeout(t); resolve({ host: m[1], port: m[2] }); } });
        child.on('exit', () => reject(new Error('exited: ' + buf)));
      });
      assert.equal(url.host, '127.0.0.1');
      const res = await fetch(`http://127.0.0.1:${url.port}/api/health`);
      const j = await res.json();
      assert.equal(j.mode, 'twin');
      assert.equal(j.bind, '127.0.0.1');
      const an = await fetch(`http://127.0.0.1:${url.port}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: CONTRACT }) });
      assert.equal((await an.json()).verified, true);
    } finally { child.kill(); }
  });
  test('unknown TWIN_SCRIPT is rejected with the list of valid values', async () => {
    const child = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0', SAFEREDLINE_TWIN: '1', TWIN_SCRIPT: 'bogus' } });
    let err = ''; child.stderr.on('data', (d) => (err += d));
    const code = await new Promise((r) => child.on('exit', r));
    assert.notEqual(code, 0);
    assert.match(err, /Unknown TWIN_SCRIPT/);
  });
});
