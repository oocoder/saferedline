import { createServer } from '../src/server.mjs';
import { installTwin } from './twin/install.mjs';

export const SENTINEL = 'ZXQ-SECRET-7731';
export const CONTRACT = `CONFIDENTIAL AGREEMENT ${SENTINEL}. The Recipient shall keep all information secret in perpetuity “forever” — § 9 café.`;

/** Boot twin + app server on ephemeral ports. */
export async function boot({ serverOpts = {}, ...opts } = {}) {
  const t = await installTwin(opts);
  const server = createServer({ mode: 'twin', ...serverOpts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const raw = await res.text();
    let json; try { json = JSON.parse(raw); } catch { json = null; }
    return { status: res.status, headers: res.headers, json, raw };
  };
  const get = async (p) => {
    const res = await fetch(base + p);
    const raw = await res.text();
    let json; try { json = JSON.parse(raw); } catch { json = null; }
    return { status: res.status, headers: res.headers, json, raw };
  };
  const close = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await t.restore(); };
  return { ...t, base, post, get, close, server };
}

export function assertEnvelope(assert, r, code, status, contractSent) {
  assert.equal(r.status, status, r.raw.slice(0, 300));
  assert.equal(r.json.error.code, code);
  assert.equal(typeof r.json.error.message, 'string');
  assert.ok(['input', 'config', 'attestation', 'inference', 'signature', 'server'].includes(r.json.error.stage));
  assert.equal(r.json.error.contractSent, contractSent);
}

import http from 'node:http';
/** Raw request (lets tests set Host / Origin / X-Forwarded-For, which fetch forbids). */
export const rawReq = (base, { method = 'GET', p = '/api/health', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  const r = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => {
    let b = ''; res.on('data', (d) => (b += d));
    res.on('end', () => { let json; try { json = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, raw: b }); });
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});
