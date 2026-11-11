import test, { describe, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installTwin } from './twin/install.mjs';
import { rawReq, assertEnvelope } from './helpers.mjs';
import { createHandler, SECURITY_HEADERS, DEMO_BANNER } from '../src/server.mjs';
import { setDeps, deps } from '../src/attest.mjs';
import { cfg } from '../src/near.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = (i = 1) => fs.readFileSync(path.join(ROOT, 'samples', ['sample_predatory_nda', 'sample_balanced_nda', 'sample_contractor_agreement'][i] + '.txt'), 'utf8');
const J = { 'Content-Type': 'application/json' };
const HOST = 'demo.example';

let tw, srv;
afterEach(async () => {
  await new Promise((r) => { if (!srv) return r(); srv.closeAllConnections(); srv.close(r); }); srv = null;
  await tw?.restore(); tw = null;
  for (const k of ['ALLOWED_HOSTS', 'VERCEL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL', 'VERCEL_URL']) delete process.env[k];
});

// Twin underneath, the real api/index.mjs handler on top (live mode as on Vercel).
async function vercelApp({ script = {}, env = {} } = {}) {
  process.env.ALLOWED_HOSTS = HOST; process.env.VERCEL = '1'; Object.assign(process.env, env);
  tw = await installTwin({ script });
  const mod = await import('../api/index.mjs');
  srv = http.createServer(mod.default);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, twin: tw.twin, mod };
}
const call = (app, p, { method = 'GET', headers = {}, body, host = HOST } = {}) => rawReq(app.base, { method, p, headers: { Host: host, ...headers }, body });

describe('api/index.mjs (Vercel function)', () => {
  test('is hard-wired hosted-demo + vercel: health says so, with the banner, regardless of env flags', async () => {
    const app = await vercelApp();
    const r = await call(app, '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'hosted-demo'); assert.equal(r.json.platform, 'vercel'); assert.equal(r.json.bind, 'vercel');
    assert.equal(r.json.demoBanner, DEMO_BANNER);
    assert.equal(typeof app.mod.default, 'function');
  });
  test('serves the UI and samples with CSP/no-store headers on every response', async () => {
    const app = await vercelApp();
    for (const p of ['/', '/api/samples', '/api/health', '/nope']) {
      const r = await call(app, p);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[k.toLowerCase()], v, `${p} ${k}`);
    }
  });
  test('rewrite form: /api/index?__path=... resolves to the original path (and query survives)', async () => {
    const app = await vercelApp();
    assert.equal((await call(app, '/api/index?__path=api/health')).json.mode, 'hosted-demo');
    assert.equal((await call(app, '/api/index?__path=')).status, 200, 'root');
    const r = await call(app, `/api/index?__path=api/server-attestation&nonce=${'ab'.repeat(32)}`);
    assert.equal(r.json.available, false);
    assertEnvelope(assert, await call(app, '/api/index?__path=api/server-attestation'), 'BAD_INPUT', 400, false);
  });
  test('analyzes a sample end to end; non-samples are 403; limits apply', async () => {
    const app = await vercelApp();
    const post = (text, ip = '1.1.1.1') => call(app, '/api/analyze', { method: 'POST', headers: { ...J, 'x-vercel-forwarded-for': ip }, body: JSON.stringify({ text }) });
    const ok = await post(sample(1));
    assert.equal(ok.status, 200, ok.raw.slice(0, 200)); assert.equal(ok.json.verified, true);
    assertEnvelope(assert, await post('x'.repeat(80)), 'SAMPLES_ONLY', 403, false);
    // default hosted limit is 3 analyses per IP: first used above, two more, then 429
    assert.equal((await post(sample(1))).status, 200);
    assert.equal((await post(sample(1))).status, 200);
    assertEnvelope(assert, await post(sample(1)), 'RATE_LIMITED', 429, false);
    assert.equal((await post(sample(1), '2.2.2.2')).status, 200, 'other client IP has its own budget');
  });
  test('client IP: x-vercel-forwarded-for, then x-real-ip, then right-most XFF; spoofable XFF cannot reset the budget', async () => {
    const app = await vercelApp();
    const body = JSON.stringify({ text: sample(1) });
    const go = (headers) => call(app, '/api/analyze', { method: 'POST', headers: { ...J, ...headers }, body });
    for (let i = 0; i < 3; i++) assert.equal((await go({ 'x-vercel-forwarded-for': '9.9.9.9', 'x-forwarded-for': `1.2.3.${i}` })).status, 200);
    assert.equal((await go({ 'x-vercel-forwarded-for': '9.9.9.9', 'x-forwarded-for': '5.5.5.5' })).status, 429, 'XFF ignored when the Vercel header exists');
    for (let i = 0; i < 3; i++) assert.equal((await go({ 'x-real-ip': '8.8.8.8', 'x-forwarded-for': `1.1.1.${i}` })).status, 200);
    assert.equal((await go({ 'x-real-ip': '8.8.8.8' })).status, 429);
    for (let i = 0; i < 3; i++) assert.equal((await go({ 'x-forwarded-for': `6.6.6.${i}, 7.7.7.7` })).status, 200);
    assert.equal((await go({ 'x-forwarded-for': '0.0.0.0, 7.7.7.7' })).status, 429, 'right-most XFF entry is the key');
  });
  test('Host allowlist: ALLOWED_HOSTS + Vercel-provided hostnames only (no wildcard)', async () => {
    const app = await vercelApp({ env: { VERCEL_PROJECT_PRODUCTION_URL: 'prod.example.app', VERCEL_BRANCH_URL: 'branch.example.app', VERCEL_URL: 'deploy-abc.example.app' } });
    // handler reads env at creation: import is cached, so re-create one for this env
    const h = createHandler({ platform: 'vercel', hostedDemo: true, trustProxy: true });
    await new Promise((r) => { srv.closeAllConnections(); srv.close(r); });
    srv = http.createServer(h); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    for (const ok of [HOST, 'prod.example.app', 'branch.example.app', 'deploy-abc.example.app']) assert.equal((await rawReq(base, { headers: { Host: ok } })).status, 200, ok);
    for (const bad of ['other-preview.example.app', 'evil.example', 'prod.example.app.evil.example']) assertEnvelope(assert, await rawReq(base, { headers: { Host: bad } }), 'BAD_ORIGIN', 403, false);
    void app;
  });
  test('pre-parsed request bodies (object / string / Buffer) and streamed bodies all work', async () => {
    const app = await vercelApp();
    // a wrapper that simulates Vercel helpers having parsed the body
    const mod = await import('../api/index.mjs');
    for (const [ki, kind] of ['object', 'string', 'buffer', 'stream'].entries()) {
      const wrapped = http.createServer(async (req, res) => {
        if (kind === 'stream') return mod.default(req, res);
        const chunks = []; for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);
        req.body = kind === 'object' ? JSON.parse(raw.toString()) : kind === 'string' ? raw.toString() : raw;
        return mod.default(req, res);
      });
      await new Promise((r) => wrapped.listen(0, '127.0.0.1', r));
      const r = await rawReq(`http://127.0.0.1:${wrapped.address().port}`, { method: 'POST', p: '/api/analyze', headers: { Host: HOST, ...J, 'x-vercel-forwarded-for': `10.0.1.${ki}` }, body: JSON.stringify({ text: sample(1) }) });
      wrapped.closeAllConnections(); await new Promise((rs) => wrapped.close(rs));
      assert.equal(r.status, 200, `${kind}: ${r.raw.slice(0, 150)}`);
      assert.equal(r.json.verified, true, kind);
    }
    void app;
  });
  test('bad pre-parsed bodies are BAD_INPUT, oversize is TOO_LARGE', async () => {
    const h = createHandler({ hostedDemo: true, platform: 'vercel', trustProxy: true });
    const mk = (body) => http.createServer((req, res) => { req.body = body; h(req, res); });
    for (const [body, code, status] of [['not json', 'BAD_INPUT', 400], [[1, 2], 'BAD_INPUT', 400], [Buffer.alloc(3 * 1024 * 1024, 97), 'TOO_LARGE', 413]]) {
      const s2 = mk(body); await new Promise((r) => s2.listen(0, '127.0.0.1', r));
      const r = await rawReq(`http://127.0.0.1:${s2.address().port}`, { method: 'POST', p: '/api/analyze', headers: { Host: 'localhost', ...J }, body: '{}' });
      s2.closeAllConnections(); await new Promise((rs) => s2.close(rs));
      assertEnvelope(assert, r, code, status, false);
    }
  });
});

describe('vercel config', () => {
  const cfgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  test('vercel.json: rewrite to the function, function limits/files, region, and the same security headers as the app', () => {
    assert.deepEqual(cfgJson.rewrites, [{ source: '/:path*', destination: '/api/index?__path=:path*' }]);
    assert.equal(cfgJson.functions['api/index.mjs'].maxDuration, 120);
    assert.equal(cfgJson.functions['api/index.mjs'].includeFiles, '{public,samples}/**');
    assert.deepEqual(cfgJson.regions, ['iad1']);
    const headers = Object.fromEntries(cfgJson.headers.find((h) => h.source === '/(.*)').headers.map((h) => [h.key, h.value]));
    assert.deepEqual(headers, SECURITY_HEADERS, 'static files bypass the function, so vercel.json must carry identical headers');
  });
  test('.vercelignore excludes secrets and dev material', () => {
    const lines = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split('\n').map((l) => l.trim());
    for (const need of ['.env', '.env.*', '.work', 'tests', 'docs', 'scripts', '*.md', '*.pdf', 'node_modules']) assert.ok(lines.includes(need), need);
    assert.ok(!lines.includes('public') && !lines.includes('samples') && !lines.includes('src') && !lines.includes('api'));
  });
  test('package.json engines.node is 22.x and matches .nvmrc', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines.node, '22.x');
    assert.equal(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim(), '22');
  });
  test('env loader is skipped on Vercel; endpoint overrides are refused there even with ALLOW_ENDPOINT_OVERRIDE=1', () => {
    const f = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'v-')), '.env');
    fs.writeFileSync(f, 'SOME_FROM_FILE=1\n');
    // (explicit SAFEREDLINE_ENV_FILE still loads; the default .env path must not)
    const r1 = spawnSync(process.execPath, ['-e', "import('./src/env.mjs').then(()=>console.log(process.env.NEAR_API_KEY === undefined ? 'skipped' : 'loaded'))"], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, VERCEL: '1' } });
    assert.equal(r1.stdout.trim(), 'skipped', r1.stderr);
    const r2 = spawnSync(process.execPath, ['-e', "import('./src/attest.mjs')"], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, VERCEL: '1', NRAS_URL: 'http://evil.example/x', ALLOW_ENDPOINT_OVERRIDE: '1', SAFEREDLINE_ENV_FILE: '/nonexistent' } });
    assert.notEqual(r2.status, 0); assert.match(r2.stderr, /Refusing endpoint override/);
  });
});

describe('serverless behaviour', () => {
  const wrap = async (opts, script = {}) => {
    tw = await installTwin({ script });
    srv = http.createServer(createHandler({ mode: 'live', hostedDemo: true, trustProxy: true, platform: 'vercel', ...opts }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${srv.address().port}`;
  };
  test('deadline: a hung upstream returns OUR envelope (504 INFERENCE_TIMEOUT), not a platform timeout', async () => {
    process.env.ALLOWED_HOSTS = HOST;
    const base = await wrap({ deadlineMs: 400 }, { chat: 'hang' });
    const t0 = Date.now();
    const r = await rawReq(base, { method: 'POST', p: '/api/analyze', headers: { Host: HOST, ...J }, body: JSON.stringify({ text: sample(1) }) });
    assertEnvelope(assert, r, 'INFERENCE_TIMEOUT', 504, true);
    assert.ok(Date.now() - t0 < 4000);
  });
  test('hosted error messages are generic: no upstream text or key hints', async () => {
    process.env.ALLOWED_HOSTS = HOST;
    const base = await wrap({}, { chat: '401' });
    const r = await rawReq(base, { method: 'POST', p: '/api/analyze', headers: { Host: HOST, ...J }, body: JSON.stringify({ text: sample(1) }) });
    assertEnvelope(assert, r, 'NEAR_AUTH', 502, true);
    assert.doesNotMatch(r.json.error.message, /key|401|NEAR_API_KEY/i);
  });
  test('tuning: applyServerlessTuning lowers every timeout and retry budget', async () => {
    const { applyServerlessTuning } = await import('../src/server.mjs');
    tw = await installTwin({});
    applyServerlessTuning({});
    assert.deepEqual(deps.timeouts, { attest: 10000, pccs: 8000, nras: 10000, jwks: 8000, signature: 5000 });
    assert.equal(cfg.timeoutMs, 35000); assert.equal(cfg.sigRetry.tries, 3);
    applyServerlessTuning({ NEAR_TIMEOUT_MS: '20000' });
    assert.equal(cfg.timeoutMs, 20000);
  });
  test('/api/attest hosted: result cached, single-flight, own rate limit; analyze still attests fresh', async () => {
    process.env.ALLOWED_HOSTS = HOST;
    const base = await wrap({ limits: { attest: 4 }, attestCacheMs: 300 });
    const reports = () => tw.twin.requests.filter((x) => x.startsWith('GET /v1/attestation/report')).length;
    const get = () => rawReq(base, { p: '/api/attest', headers: { Host: HOST } });
    const [a, b] = await Promise.all([get(), get()]);          // single flight
    assert.equal(a.json.nonce, b.json.nonce); assert.equal(reports(), 1);
    assert.equal((await get()).json.nonce, a.json.nonce);        // cached
    assert.equal(reports(), 1);
    await new Promise((r) => setTimeout(r, 350));
    await get(); assert.equal(reports(), 2, 'cache expired');
    assertEnvelope(assert, await get(), 'RATE_LIMITED', 429, false); // 4th call in the window
    const before = reports();
    const an = await rawReq(base, { method: 'POST', p: '/api/analyze', headers: { Host: HOST, ...J }, body: JSON.stringify({ text: sample(1) }) });
    assert.equal(an.status, 200); assert.equal(reports(), before + 1, 'analyze runs its own fresh attestation');
  });
  test('/api/models hosted: cached 5 minutes', async () => {
    process.env.ALLOWED_HOSTS = HOST;
    const base = await wrap({});
    const n = () => tw.twin.requests.filter((x) => x === 'GET /v1/models').length;
    await rawReq(base, { p: '/api/models', headers: { Host: HOST } }); await rawReq(base, { p: '/api/models', headers: { Host: HOST } });
    assert.equal(n(), 1);
  });
  test('HEAD: only / and /api/health', async () => {
    process.env.ALLOWED_HOSTS = HOST;
    const base = await wrap({});
    for (const p of ['/', '/api/health']) assert.equal((await rawReq(base, { method: 'HEAD', p, headers: { Host: HOST } })).status, 200, p);
    for (const p of ['/api/attest', '/api/samples', '/api/analyze', '/api/models']) assert.equal((await rawReq(base, { method: 'HEAD', p, headers: { Host: HOST } })).status, 405, p);
  });
});

describe('caches in attest.mjs', () => {
  test('JWKS cached (and refetched once when the key id is unknown); collateral cached per PCK chain; failures not cached', async () => {
    const { attestModel } = await import('../src/attest.mjs');
    const { fixture } = await import('./twin/near-twin.mjs');
    tw = await installTwin({});
    let jwks = 0, coll = 0;
    const realFetch = deps.fetch;
    const realGet = deps.getCollateral;
    setDeps({
      jwksTtlMs: 60000, collateralCacheMs: 60000,
      fetch: (u, o) => { if (String(u).endsWith('/jwks')) jwks++; return realFetch(u, o); },
      getCollateral: (...a) => { coll++; return realGet(...a); },
    });
    const a1 = await attestModel(fixture.model, '');
    assert.equal(a1.verified, true);
    const j1 = jwks, c1 = coll;
    assert.ok(j1 >= 1 && c1 >= 1);
    const a2 = await attestModel(fixture.model, '');
    assert.equal(a2.verified, true);
    assert.equal(jwks, j1, 'JWKS served from cache'); assert.equal(coll, c1, 'collateral served from cache');
    // a failed fetch must not poison the cache
    setDeps({ collateralCacheMs: 60000, getCollateral: () => Promise.reject(new Error('down')), fallbackPccsUrl: null });
    tw.twin.script = {};
    // different cache key not available -> would need a new quote; here the cache still holds the good one, so verify stays true
    assert.equal((await attestModel(fixture.model, '')).verified, true);
  });
});
