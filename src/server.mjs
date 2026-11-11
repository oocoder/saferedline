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
import { analyzeContract, askFollowUp, listTeeModels, cfg, keyConfigured } from './near.mjs';
import { attestModel, endpointOverrides } from './attest.mjs';
import { AppError } from './errors.mjs';
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

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, max-age=0', // never cache contract-bearing responses
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // connect-src 'self': the page cannot send the contract anywhere except this local server.
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; worker-src blob: https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function envelope(e) {
  const known = e instanceof AppError;
  // Unknown errors get a fixed message: parser/library messages can quote request content.
  const err = known ? e : new AppError('Internal error', {});
  return [err.status, {
    error: { code: err.code, message: err.message, stage: err.stage, contractSent: !!err.contractSent },
    ...(err.attestation ? { attestation: err.attestation } : {}),
  }];
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; return; } // keep draining; reject on end
      if (!over) chunks.push(c);
    });
    req.on('end', () => {
      if (over) return reject(new AppError('Contract too large (max 512 KB of text)', { status: 413, code: 'TOO_LARGE', stage: 'input' }));
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape');
        resolve(v);
      } catch { reject(new AppError('Request body must be a JSON object', { status: 400, code: 'BAD_INPUT', stage: 'input' })); }
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
  analyze: Number(process.env.DEMO_ANALYZE_LIMIT) || 5,   // per IP per window
  ask: Number(process.env.DEMO_ASK_LIMIT) || 20,          // per IP per window
  daily: Number(process.env.DEMO_DAILY_CAP) || 200,       // global, analyses + follow-ups, per UTC day
  now: () => Date.now(),
});
const rateError = (message, retryAfter) => Object.assign(new AppError(message, { status: 429, code: 'RATE_LIMITED', stage: 'input' }), { retryAfter });

/** In-memory only (a Map with expiry): no persistence, resets on restart. */
export function makeLimiter(l) {
  const hits = new Map(); let day = '', daily = 0;
  return {
    check(ip, kind) {
      const t = l.now(); const d = new Date(t).toISOString().slice(0, 10);
      if (d !== day) { day = d; daily = 0; }
      if (daily >= l.daily) throw rateError('Hosted demo daily capacity reached — try again tomorrow.', Math.ceil((Date.parse(d) + 86400000 - t) / 1000));
      const key = `${ip}|${kind}`;
      const arr = (hits.get(key) || []).filter((x) => t - x < l.window);
      if (arr.length >= l[kind]) throw rateError(`Rate limit: at most ${l[kind]} ${kind === 'ask' ? 'follow-ups' : 'analyses'} per ${Math.round(l.window / MIN)} minutes per visitor.`, Math.ceil((arr[0] + l.window - t) / 1000));
      arr.push(t); hits.set(key, arr); daily++;
      if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((x) => t - x < l.window)) hits.delete(k);
    },
  };
}

export function createServer({ mode = 'live', host = '127.0.0.1', hostedDemo = false, limits = {}, trustProxy = false } = {}) {
  const limiter = hostedDemo ? makeLimiter({ ...defaultLimits(), ...limits }) : null;
  // Behind a trusted platform proxy the client is the right-most X-Forwarded-For entry (the one the proxy appended).
  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',').at(-1).trim() : req.socket.remoteAddress) || 'unknown';
  const sampleTexts = () => new Set(samples().map((x) => x.text.trim()));
  const hostedGate = (req, text, kind) => {
    if (!hostedDemo) return;
    if (!sampleTexts().has(text)) throw new AppError('Hosted demo accepts the bundled fictional samples only — run locally for real contracts', { status: 403, code: 'SAMPLES_ONLY', stage: 'input' });
    limiter.check(clientIp(req), kind);
  };
  const routes = {
    'GET /': (req, res) => send(res, 200, indexHtml(), 'text/html; charset=utf-8'),
    'GET /api/samples': (req, res) => send(res, 200, samples()),
    'GET /api/health': (req, res) => send(res, 200, { ok: true, model: cfg.model, apiKeyConfigured: mode === 'twin' ? false : keyConfigured(), ...(mode === 'twin' ? { twinFakeKey: true } : {}), mode: hostedDemo ? 'hosted-demo' : mode, persistence: 'none', bind: host, version: VERSION, warnings: endpointOverrides.length ? [`Endpoint override active (${endpointOverrides.join(', ')}): attestation/contract traffic is not going to the default NEAR/Intel/NVIDIA endpoints.`] : [] }),
    'GET /api/models': async (req, res) => send(res, 200, await listTeeModels()),
    // Attestation alone needs no API key — judges can verify the enclave independently.
    'GET /api/attest': async (req, res) => send(res, 200, await attestModel(cfg.model, cfg.apiKey)),
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

  const extraHosts = String(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const hostOk = (h) => { const n = String(h || '').toLowerCase().replace(/:\d+$/, ''); return ['localhost', '127.0.0.1', '[::1]'].includes(n) || extraHosts.includes(n); };

  // Local-CSRF / DNS-rebinding defense: only same-origin requests to a loopback Host may reach the API.
  function guard(req) {
    const deny = (m, status = 403, code = 'BAD_ORIGIN') => new AppError(m, { status, code, stage: 'input' });
    if (!hostOk(req.headers.host)) throw deny('Host header not allowed (SafeRedline only answers on localhost).');
    if (req.headers.origin !== undefined && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin)) throw deny('Cross-origin request refused.');
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) throw deny('Content-Type must be application/json.', 415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const method = req.method === 'HEAD' ? 'GET' : req.method; // HEAD = GET without a body
    const key = `${method} ${req.url.split('?')[0]}`;
    const handler = routes[key];
    try {
      guard(req);
      if (!handler) throw new AppError('Not found', { status: 404, code: 'NOT_FOUND', stage: 'input' });
      // X-Twin-Script: honoured ONLY in twin mode (never live, never hosted-demo); per-request via AsyncLocalStorage.
      const twinScript = mode === 'twin' && !hostedDemo ? String(req.headers['x-twin-script'] || '').toLowerCase() : '';
      if (twinScript && !TWIN_HEADER_ALLOWLIST.includes(twinScript)) throw new AppError(`X-Twin-Script must be one of: ${TWIN_HEADER_ALLOWLIST.join(', ')}`, { status: 400, code: 'BAD_INPUT', stage: 'input' });
      if (twinScript) await twinCtx.run({ script: twinScript }, () => handler(req, res)); else await handler(req, res);
    } catch (e) {
      const [status, body] = envelope(e);
      if (!res.headersSent) send(res, status, body, 'application/json', e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {}); else res.end();
    } finally {
      // Metadata only — never contract text, prompts, or model output.
      console.log(`${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  });
}

function fail(m) { console.error(`\n  ${m}\n`); process.exit(1); }

async function main() {
  const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
  const hostedDemo = process.env.HOSTED_DEMO === '1';
  const HOST = process.env.HOST || '127.0.0.1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (!loopback && !hostedDemo) fail(`Refusing to bind ${HOST}: SafeRedline is loopback-only unless HOSTED_DEMO=1 (public demo of bundled samples).`);
  if (hostedDemo && !loopback && !process.env.ALLOWED_HOSTS) fail('HOSTED_DEMO on a public bind needs ALLOWED_HOSTS=<your public hostname> (Host-header allowlist).');
  let mode = 'live';
  if (process.env.SAFEREDLINE_TWIN) {
    const { installTwin, resolveScript } = await import('../tests/twin/install.mjs');
    await installTwin({ script: resolveScript(process.env.TWIN_SCRIPT) });
    mode = 'twin';
  }
  const server = createServer({ mode, host: HOST, hostedDemo, trustProxy: process.env.TRUST_PROXY === '1' });
  server.listen(PORT, HOST, () => {
    const { port } = server.address();
    console.log(`\n  SafeRedline running → http://${HOST}:${port}`);
    if (mode === 'twin') {
      console.log(`  TWIN MODE (script: ${process.env.TWIN_SCRIPT || 'ok'}): simulated NEAR, recorded real attestation — NOT a real TEE`);
    } else {
      console.log(`  Model: ${cfg.model} (NEAR AI Cloud, Confidential TEE)`);
      console.log(`  API key: ${keyConfigured() ? 'configured' : 'NOT CONFIGURED (empty, placeholder, or not an sk- key) — set NEAR_API_KEY in .env; analysis will return NO_API_KEY'}`);
    }
    if (hostedDemo) console.log('  HOSTED DEMO: bundled fictional samples only; per-IP + daily rate limits (in memory)');
    console.log('  Persistence: none (no disk, no DB, no content logging)\n');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
