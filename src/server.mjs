// SafeRedline HTTP server — stateless by design.
//
// ZERO SERVER-SIDE RETENTION
//  * No database, no file writes, no cache, no session store.
//  * Request bodies are read into a local variable, used for one NEAR AI Cloud call,
//    and released when the handler returns (garbage-collected).
//  * We never log request or response content — only method, path, status, timing.
//  * Responses carry `Cache-Control: no-store` so browsers/proxies don't keep them either.
//  * Binds 127.0.0.1 by default (HOST env to override): the contract stays on your machine
//    until it is sent, after attestation, to the NEAR enclave.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeContract, askFollowUp, listTeeModels, cfg, keyConfigured, setNearDeps } from './near.mjs';
import { attestModel, endpointOverrides, setDeps } from './attest.mjs';
import { AppError } from './errors.mjs';
import { nonceFromQuery, serverAttestation } from './dstack.mjs';
import { twinCtx, TWIN_HEADER_ALLOWLIST } from './twinctx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 2 * 1024 * 1024; // raw JSON bytes
const MAX_TEXT = 512 * 1024;      // contract characters
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })();

// Bundled fictional samples + UI, read lazily (public/index.html may not exist yet).
const SAMPLE_META = [
  ['sample_predatory_nda', 'Predatory SaaS NDA', 'High'],
  ['sample_balanced_nda', 'Balanced Mutual NDA', 'Low'],
  ['sample_contractor_agreement', 'Contractor Services Agreement', 'High'],
];
let samplesCache;
const samples = () => (samplesCache ??= SAMPLE_META.map(([id, title, riskHint]) => ({
  id, title, riskHint, text: fs.readFileSync(path.join(ROOT, 'samples', `${id}.txt`), 'utf8'),
})));
const indexHtml = () => {
  try { return fs.readFileSync(path.join(ROOT, 'public', 'index.html')); } catch {
    return '<!doctype html><meta charset="utf-8"><title>SafeRedline</title><p>public/index.html not found. The API is up: see /api/health.';
  }
};

export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, max-age=0', // never cache contract-bearing responses
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // connect-src 'self': the page cannot send the contract anywhere except this local server.
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; worker-src blob: https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

function send(res, status, body, type = 'application/json', extra = {}) {
  if (res.writableEnded || res.headersSent) return; // e.g. the deadline already answered
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

// Hosted demo: the public sees fixed messages for upstream-derived failures (no upstream snippets, no key hints).
const HOSTED_MESSAGES = {
  ATTESTATION_UNAVAILABLE: "We couldn't reach one of the attestation sources (NEAR, Intel or NVIDIA), so we stopped. Contract not sent. Please try again shortly.",
  NEAR_AUTH: 'The demo backend is temporarily unavailable. Try again later.',
  INFERENCE_FAILED: 'The model request failed. Try again shortly.',
  INTERNAL: 'Internal error',
};

function envelope(e, hosted = false) {
  const known = e instanceof AppError;
  // Unknown errors get a fixed message: parser/library messages can quote request content.
  const err = known ? e : new AppError('Internal error', {});
  const message = hosted && HOSTED_MESSAGES[err.code] ? HOSTED_MESSAGES[err.code] : err.message;
  return [err.status, {
    error: { code: err.code, message, stage: err.stage, contractSent: !!err.contractSent },
    ...(err.attestation ? { attestation: err.attestation } : {}),
  }];
}

const badJson = () => new AppError('Request body must be a JSON object', { status: 400, code: 'BAD_INPUT', stage: 'input' });
const tooLarge = () => new AppError('Contract too large (max 512 KB of text)', { status: 413, code: 'TOO_LARGE', stage: 'input' });
const asObject = (v) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw badJson(); return v; };

function readJson(req) {
  // Platforms (e.g. Vercel helpers) may have consumed the stream and parsed the body already.
  const pre = req.body;
  if (pre !== undefined && pre !== null) {
    if (Buffer.isBuffer(pre) || typeof pre === 'string') {
      if (Buffer.byteLength(pre) > MAX_BODY) return Promise.reject(tooLarge());
      try { return Promise.resolve(asObject(JSON.parse(Buffer.isBuffer(pre) ? pre.toString('utf8') : pre || '{}'))); } catch { return Promise.reject(badJson()); }
    }
    try { return Promise.resolve(asObject(pre)); } catch (e) { return Promise.reject(e); }
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; return; } // keep draining; reject on end
      if (!over) chunks.push(c);
    });
    req.on('end', () => {
      if (over) return reject(tooLarge());
      try { resolve(asObject(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))); } catch { reject(badJson()); }
    });
    req.on('error', reject);
  });
}

const bad = (m) => new AppError(m, { status: 400, code: 'BAD_INPUT', stage: 'input' });
function contractText(v) {
  if (typeof v !== 'string') throw bad('Provide the contract as a text string.');
  if (v.length > MAX_TEXT) throw new AppError('Contract too large (max 512 KB of text)', { status: 413, code: 'TOO_LARGE', stage: 'input' });
  const t = v.trim();
  if (t.length < 50) throw bad('Paste a contract (at least 50 characters).');
  return t;
}

// ---- HOSTED_DEMO mode: public showcase that only ever processes the bundled fictional samples ----
const MIN = 60 * 1000;
export const defaultLimits = () => ({
  window: Number(process.env.DEMO_WINDOW_MS) || 10 * MIN,
  analyze: Number(process.env.DEMO_ANALYZE_LIMIT) || 3,   // per IP per window (per server instance on serverless)
  ask: Number(process.env.DEMO_ASK_LIMIT) || 20,          // per IP per window
  quote: Number(process.env.DEMO_QUOTE_LIMIT) || 30,      // server-attestation quotes per IP per window (not counted in the daily cap)
  attest: Number(process.env.DEMO_ATTEST_LIMIT) || 10,    // /api/attest per IP per window (not counted in the daily cap)
  daily: Number(process.env.DEMO_DAILY_CAP) || 60,        // analyses + follow-ups per UTC day, per server instance; the NEAR key's spend cap is the real backstop
  now: () => Date.now(),
});
const rateError = (message, retryAfter) => Object.assign(new AppError(message, { status: 429, code: 'RATE_LIMITED', stage: 'input' }), { retryAfter });

const UNCOUNTED = new Set(['quote', 'attest']); // do not consume the analysis/follow-up daily budget

/** In-memory only (a Map with expiry): no persistence, resets on restart. */
export function makeLimiter(l) {
  const hits = new Map(); let day = '', daily = 0;
  return {
    check(ip, kind) {
      const t = l.now(); const d = new Date(t).toISOString().slice(0, 10);
      if (d !== day) { day = d; daily = 0; }
      if (!UNCOUNTED.has(kind) && daily >= l.daily) throw rateError('The hosted demo has reached its daily limit. Please try again tomorrow.', Math.ceil((Date.parse(d) + 86400000 - t) / 1000));
      const key = `${ip}|${kind}`;
      const arr = (hits.get(key) || []).filter((x) => t - x < l.window);
      if (arr.length >= l[kind]) throw rateError(`Rate limit: at most ${l[kind]} ${{ ask: 'follow-ups', quote: 'server attestations', attest: 'attestation checks' }[kind] || 'analyses'} per ${Math.round(l.window / MIN)} minutes per visitor.`, Math.ceil((arr[0] + l.window - t) / 1000));
      arr.push(t); hits.set(key, arr); if (!UNCOUNTED.has(kind)) daily++;
      if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((x) => t - x < l.window)) hits.delete(k);
    },
  };
}

export const DEMO_BANNER = 'Hosted demo: fictional samples only. To review a real contract, run SafeRedline locally (github.com/oocoder/saferedline).';

/** Lower timeouts so a request always finishes inside a serverless function budget (called by api/index.mjs). */
export function applyServerlessTuning(env = process.env) {
  setNearDeps({ timeoutMs: Number(env.NEAR_TIMEOUT_MS) || 35000, sigRetry: { tries: 3, delays: [300, 600] } });
  setDeps({ timeouts: { attest: 10000, pccs: 8000, nras: 10000, jwks: 8000, signature: 5000 } });
}

const vercelHosts = (env) => ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL', 'VERCEL_URL'].map((k) => String(env[k] || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);

/** (req, res) request handler: routes + guard + envelope. createServer wraps it; api/index.mjs exports it for Vercel. */
export function createHandler({ mode = 'live', host = '127.0.0.1', hostedDemo = false, limits = {}, trustProxy = false, platform, deadlineMs = 0, attestCacheMs = 45000, modelsCacheMs = 5 * 60 * 1000, env = process.env } = {}) {
  const onVercel = platform === 'vercel' || (platform === undefined && !!env.VERCEL);
  const limiter = hostedDemo ? makeLimiter({ ...defaultLimits(), ...limits }) : null;
  // Client IP behind a trusted proxy. On Vercel the platform sets x-vercel-forwarded-for / x-real-ip (clients cannot spoof them);
  // elsewhere only the right-most X-Forwarded-For entry (appended by our own proxy) is trusted.
  const clientIp = (req) => {
    const h = req.headers; const first = (v) => String(v || '').split(',')[0].trim();
    if (trustProxy) {
      if (onVercel) { const v = first(h['x-vercel-forwarded-for']) || first(h['x-real-ip']); if (v) return v; }
      if (h['x-forwarded-for']) return String(h['x-forwarded-for']).split(',').at(-1).trim();
    }
    return req.socket?.remoteAddress || 'unknown';
  };
  const sampleTexts = () => new Set(samples().map((x) => x.text.trim()));
  const hostedGate = (req, text, kind) => {
    if (!hostedDemo) return;
    if (!sampleTexts().has(text)) throw new AppError('The hosted demo accepts the bundled fictional samples only. Run SafeRedline locally for real contracts.', { status: 403, code: 'SAMPLES_ONLY', stage: 'input' });
    limiter.check(clientIp(req), kind);
  };

  // Hosted /api/attest: own rate limit + single-flight + short result cache (the server chooses the nonce; verifiedAt is shown).
  // analyze/ask always run a FRESH attestation inside the pipeline.
  let attestCache = null; let attestInflight = null;
  const cachedAttest = async () => {
    if (attestCache && Date.now() - attestCache.at < attestCacheMs) return attestCache.value;
    if (!attestInflight) {
      attestInflight = attestModel(cfg.model, cfg.apiKey).then((v) => { attestCache = { at: Date.now(), value: v }; return v; }).finally(() => { attestInflight = null; });
    }
    return attestInflight;
  };
  let modelsCache = null;

  const platformInfo = onVercel ? 'vercel' : undefined;
  const routes = {
    'GET /': (req, res) => send(res, 200, indexHtml(), 'text/html; charset=utf-8'),
    'GET /api/samples': (req, res) => send(res, 200, samples()),
    'GET /api/health': (req, res) => send(res, 200, { ok: true, model: cfg.model, apiKeyConfigured: mode === 'twin' ? false : keyConfigured(), ...(mode === 'twin' ? { twinFakeKey: true } : {}), mode: hostedDemo ? 'hosted-demo' : mode, ...(platformInfo ? { platform: platformInfo } : {}), ...(hostedDemo ? { demoBanner: DEMO_BANNER } : {}), persistence: 'none', bind: onVercel ? 'vercel' : host, version: VERSION, warnings: endpointOverrides.length ? [`Endpoint override active (${endpointOverrides.join(', ')}): attestation/contract traffic is not going to the default NEAR/Intel/NVIDIA endpoints.`] : [] }),
    // The server's OWN attestation (dstack CVM quote bound to the caller's nonce); available:false off-dstack. Hosted: rate-limited.
    'GET /api/server-attestation': async (req, res) => {
      const nonce = nonceFromQuery(req.url);
      if (hostedDemo) limiter.check(clientIp(req), 'quote');
      send(res, 200, await serverAttestation(nonce));
    },
    'GET /api/models': async (req, res) => {
      if (hostedDemo && modelsCache && Date.now() - modelsCache.at < modelsCacheMs) return send(res, 200, modelsCache.value);
      const v = await listTeeModels();
      if (hostedDemo) modelsCache = { at: Date.now(), value: v };
      send(res, 200, v);
    },
    // Attestation alone needs no API key — judges can verify the enclave independently.
    'GET /api/attest': async (req, res) => {
      if (hostedDemo) { limiter.check(clientIp(req), 'attest'); return send(res, 200, await cachedAttest()); }
      send(res, 200, await attestModel(cfg.model, cfg.apiKey));
    },
    'POST /api/analyze': async (req, res) => {
      const body = await readJson(req);
      let text = contractText(body.text);
      hostedGate(req, text, 'analyze');
      const result = await analyzeContract(text);
      text = null; // drop our only reference to the contract
      send(res, 200, result);
    },
    'POST /api/ask': async (req, res) => {
      const body = await readJson(req);
      let text = contractText(body.text);
      if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1000) throw bad('Ask a question of 1 to 1000 characters.');
      let question = body.question.trim();
      hostedGate(req, text, 'ask');
      const result = await askFollowUp(text, question);
      text = question = null;
      send(res, 200, result);
    },
  };

  const extraHosts = [...String(env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean), ...(onVercel ? vercelHosts(env) : [])];
  const hostOk = (h) => { const n = String(h || '').toLowerCase().replace(/:\d+$/, ''); return ['localhost', '127.0.0.1', '[::1]'].includes(n) || extraHosts.includes(n); };

  // Local-CSRF / DNS-rebinding defense: only same-origin requests to an allowed Host may reach the API.
  function guard(req) {
    const deny = (m, status = 403, code = 'BAD_ORIGIN') => new AppError(m, { status, code, stage: 'input' });
    if (!hostOk(req.headers.host)) throw deny('Host header not allowed (SafeRedline only answers on its own hostnames).');
    if (req.headers.origin !== undefined && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin)) throw deny('Cross-origin request refused.');
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) throw deny('Content-Type must be application/json.', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  // Vercel rewrites everything to /api/index?__path=<original path>; restore the original URL so routing is exact.
  function restoreUrl(req) {
    if (!onVercel) return;
    const u = new URL(req.url, 'http://x');
    if (!u.searchParams.has('__path')) return;
    const p = '/' + String(u.searchParams.get('__path') || '').replace(/^\/+/, '');
    u.searchParams.delete('__path');
    req.url = p + (u.search || '');
  }

  const run = async (req, res) => {
    const method = req.method === 'HEAD' ? 'GET' : req.method; // HEAD = GET without a body
    const pathOnly = req.url.split('?')[0];
    const key = `${method} ${pathOnly}`;
    const handler = routes[key];
    guard(req);
    if (req.method === 'HEAD' && pathOnly !== '/' && pathOnly !== '/api/health') {
      throw Object.assign(new AppError('HEAD is only supported for / and /api/health', { status: 405, code: 'METHOD_NOT_ALLOWED', stage: 'input' }), { allow: 'GET, HEAD' });
    }
    if (!handler) throw new AppError('Not found', { status: 404, code: 'NOT_FOUND', stage: 'input' });
    // X-Twin-Script: honoured ONLY in twin mode (never live, never hosted-demo); per-request via AsyncLocalStorage.
    const twinScript = mode === 'twin' && !hostedDemo ? String(req.headers['x-twin-script'] || '').toLowerCase() : '';
    if (twinScript && !TWIN_HEADER_ALLOWLIST.includes(twinScript)) throw new AppError(`X-Twin-Script must be one of: ${TWIN_HEADER_ALLOWLIST.join(', ')}`, { status: 400, code: 'BAD_INPUT', stage: 'input' });
    if (twinScript) await twinCtx.run({ script: twinScript }, () => handler(req, res)); else await handler(req, res);
  };

  return async (req, res) => {
    const t0 = Date.now();
    let timer;
    try {
      restoreUrl(req);
      if (deadlineMs > 0) {
        // Always answer with OUR envelope before the platform kills the function (never a bare platform 504).
        const deadline = new Promise((_, rej) => { timer = setTimeout(() => rej(new AppError('The request took too long. Try again.', { status: 504, code: 'INFERENCE_TIMEOUT', stage: 'server', contractSent: true })), deadlineMs); });
        await Promise.race([run(req, res), deadline]);
      } else await run(req, res);
    } catch (e) {
      const [status, body] = envelope(e, hostedDemo);
      const extra = { ...(e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {}), ...(e.allow ? { Allow: e.allow } : {}) };
      if (!res.headersSent) send(res, status, body, 'application/json', extra); else if (!res.writableEnded) res.end();
    } finally {
      clearTimeout(timer);
      // Metadata only — never contract text, prompts, or model output.
      console.log(`${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  };
}

export function createServer(opts = {}) { return http.createServer(createHandler(opts)); }

function fail(m) { console.error(`\n  ${m}\n`); process.exit(1); }

/** Start the local/self-hosted server (live mode). Twin mode is started by scripts/twin.mjs, never from here. */
export function startServer({ mode = 'live' } = {}) {
  const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
  const hostedDemo = process.env.HOSTED_DEMO === '1';
  const HOST = process.env.HOST || '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (!loopback && !hostedDemo) fail(`Refusing to bind ${HOST}: SafeRedline is loopback-only unless HOSTED_DEMO=1 (public demo of bundled samples).`);
  if (hostedDemo && !loopback && !process.env.ALLOWED_HOSTS) fail('HOSTED_DEMO on a public bind needs ALLOWED_HOSTS=<your public hostname> (Host-header allowlist).');
  const server = createServer({ mode, host: HOST, hostedDemo, trustProxy: process.env.TRUST_PROXY === '1' });
  server.listen(PORT, HOST, () => {
    const { port } = server.address();
    console.log(`\n  SafeRedline running → http://${HOST}:${port}`);
    if (mode === 'twin') {
      console.log(`  Twin mode (script: ${process.env.TWIN_SCRIPT || 'ok'}): simulated NEAR, recorded real attestation. Not a real TEE.`);
    } else {
      console.log(`  Model: ${cfg.model} (NEAR AI Cloud, Confidential TEE)`);
      console.log(`  API key: ${keyConfigured() ? 'configured' : 'not configured (empty, placeholder, or not an sk- key). Set NEAR_API_KEY in .env; analysis will return NO_API_KEY'}`);
    }
    if (hostedDemo) console.log('  HOSTED DEMO: bundled fictional samples only; per-IP + daily rate limits (in memory)');
    console.log('  Persistence: none (no disk, no DB, no content logging)\n');
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.SAFEREDLINE_TWIN) fail('Twin mode is started with `npm run twin` (scripts/twin.mjs), not from src/server.mjs.');
  startServer();
}
