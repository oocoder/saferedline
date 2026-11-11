// SafeRedline HTTP server — stateless by design.
//
// ZERO SERVER-SIDE RETENTION
//  * No database, no file writes, no cache, no session store.
//  * Request bodies are read into a local variable, used for one NEAR AI Cloud call,
//    and released when the handler returns (garbage-collected).
//  * We never log request or response content — only method, path, status, timing.
//  * Responses carry `Cache-Control: no-store` so browsers/proxies don't keep them either.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeContract, askFollowUp, listTeeModels, MODEL, API_KEY } from './near.mjs';
import { attestModel } from './attest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 512 * 1024; // 512 KB of contract text is plenty

// Static assets & bundled fictional samples are read-only, loaded once at boot.
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
const SAMPLES = Object.fromEntries(
  fs.readdirSync(path.join(ROOT, 'samples')).filter((f) => f.endsWith('.txt'))
    .map((f) => [f.replace(/\.txt$/, ''), fs.readFileSync(path.join(ROOT, 'samples', f), 'utf8')]),
);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Contract too large (max 512 KB)'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

const routes = {
  'GET /': (req, res) => send(res, 200, INDEX, 'text/html; charset=utf-8'),
  'GET /api/samples': (req, res) => send(res, 200, SAMPLES),
  'GET /api/health': (req, res) => send(res, 200, { ok: true, model: MODEL, apiKeyConfigured: Boolean(API_KEY), persistence: 'none' }),
  'GET /api/models': async (req, res) => send(res, 200, await listTeeModels()),
  // Attestation alone needs no API key — judges can verify the enclave independently.
  'GET /api/attest': async (req, res) => send(res, 200, await attestModel(MODEL, API_KEY)),
  'POST /api/analyze': async (req, res) => {
    let { text } = await readJson(req);
    if (!text || typeof text !== 'string' || text.trim().length < 50) return send(res, 400, { error: 'Paste a contract (at least 50 characters).' });
    const result = await analyzeContract(text);
    text = null; // drop our only reference to the contract
    send(res, 200, result);
  },
  'POST /api/ask': async (req, res) => {
    let { text, question } = await readJson(req);
    if (!text || !question) return send(res, 400, { error: 'Need contract text and a question.' });
    const result = await askFollowUp(String(text), String(question).slice(0, 1000));
    text = question = null;
    send(res, 200, result);
  },
};

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const key = `${req.method} ${req.url.split('?')[0]}`;
  const handler = routes[key];
  try {
    if (!handler) send(res, 404, { error: 'Not found' });
    else await handler(req, res);
  } catch (e) {
    send(res, e.status || 500, { error: e.message, attestation: e.attestation });
  } finally {
    // Metadata only — never contract text, prompts, or model output.
    console.log(`${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - t0}ms`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  SafeRedline running → http://localhost:${PORT}`);
  console.log(`  Model: ${MODEL} (NEAR AI Cloud, Confidential TEE)`);
  console.log(`  API key: ${API_KEY ? (API_KEY.startsWith('sk-') ? 'configured' : 'configured (WARNING: NEAR AI Cloud keys start with "sk-")') : 'MISSING — set NEAR_API_KEY in .env'}`);
  console.log('  Persistence: none (no disk, no DB, no content logging)\n');
});
