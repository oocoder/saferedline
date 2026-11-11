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
import { analyzeContract, askFollowUp, listTeeModels, cfg } from './near.mjs';
import { attestModel, endpointOverrides } from './attest.mjs';
import { AppError } from './errors.mjs';

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

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
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

export function createServer({ mode = 'live', host = '127.0.0.1' } = {}) {
  const routes = {
    'GET /': (req, res) => send(res, 200, indexHtml(), 'text/html; charset=utf-8'),
    'GET /api/samples': (req, res) => send(res, 200, samples()),
    'GET /api/health': (req, res) => send(res, 200, { ok: true, model: cfg.model, apiKeyConfigured: mode === 'twin' ? false : Boolean(cfg.apiKey), ...(mode === 'twin' ? { twinFakeKey: true } : {}), mode, persistence: 'none', bind: host, version: VERSION, warnings: endpointOverrides.length ? [`Endpoint override active (${endpointOverrides.join(', ')}): attestation/contract traffic is not going to the default NEAR/Intel/NVIDIA endpoints.`] : [] }),
    'GET /api/models': async (req, res) => send(res, 200, await listTeeModels()),
    // Attestation alone needs no API key — judges can verify the enclave independently.
    'GET /api/attest': async (req, res) => send(res, 200, await attestModel(cfg.model, cfg.apiKey)),
    'POST /api/analyze': async (req, res) => {
      const body = await readJson(req);
      let text = contractText(body.text);
      const result = await analyzeContract(text);
      text = null; // drop our only reference to the contract
      send(res, 200, result);
    },
    'POST /api/ask': async (req, res) => {
      const body = await readJson(req);
      let text = contractText(body.text);
      if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1000) throw bad('Ask a question of 1 to 1000 characters.');
      let question = body.question.trim();
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
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) throw deny('Cross-origin request refused.');
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
      await handler(req, res);
    } catch (e) {
      const [status, body] = envelope(e);
      if (!res.headersSent) send(res, status, body); else res.end();
    } finally {
      // Metadata only — never contract text, prompts, or model output.
      console.log(`${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  });
}

async function main() {
  const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
  const HOST = process.env.HOST || '127.0.0.1';
  let mode = 'live';
  if (process.env.SAFEREDLINE_TWIN) {
    const { installTwin, resolveScript } = await import('../tests/twin/install.mjs');
    await installTwin({ script: resolveScript(process.env.TWIN_SCRIPT) });
    mode = 'twin';
  }
  const server = createServer({ mode, host: HOST });
  server.listen(PORT, HOST, () => {
    const { port } = server.address();
    console.log(`\n  SafeRedline running → http://${HOST}:${port}`);
    if (mode === 'twin') {
      console.log(`  TWIN MODE (script: ${process.env.TWIN_SCRIPT || 'ok'}): simulated NEAR, recorded real attestation — NOT a real TEE`);
    } else {
      console.log(`  Model: ${cfg.model} (NEAR AI Cloud, Confidential TEE)`);
      console.log(`  API key: ${cfg.apiKey ? (cfg.apiKey.startsWith('sk-') ? 'configured' : 'configured (WARNING: NEAR AI Cloud keys start with "sk-")') : 'MISSING — set NEAR_API_KEY in .env'}`);
    }
    console.log('  Persistence: none (no disk, no DB, no content logging)\n');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
