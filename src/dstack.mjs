// Server-side attestation via the dstack guest agent (Phala Cloud / any dstack CVM, Intel TDX).
// API (https://github.com/dstack-tee/dstack, sdk/curl/api.md): HTTP over the unix socket /var/run/dstack.sock
//   POST /GetQuote {"report_data": "<hex, <=64 bytes, zero-padded>"} -> { quote, event_log, report_data, vm_config }
//   GET  /Info                                                       -> { app_id, instance_id, compose_hash, app_name, tcb_info (JSON string with app_compose), ... }
// The response never contains key material (GetKey is a different call we never make).
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { AppError } from './errors.mjs';

export const REPORT_DATA_PREFIX = 'saferedline-server-attestation:';
export const socketPath = () => process.env.DSTACK_SOCKET || '/var/run/dstack.sock';

/** report_data digest (32 bytes) binding a caller-chosen nonce: sha256("saferedline-server-attestation:" + nonce). */
export const reportDataFor = (nonce) => crypto.createHash('sha256').update(REPORT_DATA_PREFIX + nonce).digest();

function agent(sock, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ socketPath: sock, path, method, timeout: 10000, agent: false, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`dstack agent HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error('dstack agent returned non-JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('dstack agent timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export function nonceFromQuery(url) {
  const nonce = new URL(url, 'http://x').searchParams.get('nonce') || '';
  if (!/^[0-9a-f]{64}$/i.test(nonce)) throw new AppError('Query parameter nonce is required: 64 hex characters (32 random bytes).', { status: 400, code: 'BAD_INPUT', stage: 'input' });
  return nonce.toLowerCase();
}

export async function serverAttestation(nonce) {
  const sock = socketPath();
  if (!fs.existsSync(sock)) return { available: false, reason: 'not running in a dstack CVM (local/twin)' };
  const rd = reportDataFor(nonce);
  let q;
  try { q = await agent(sock, 'POST', '/GetQuote', { report_data: rd.toString('hex') }); } catch (e) {
    throw new AppError(`dstack guest agent could not produce a quote (${e.message})`, { status: 503, code: 'ATTESTATION_UNAVAILABLE', stage: 'attestation' });
  }
  if (typeof q?.quote !== 'string') throw new AppError('dstack guest agent returned no quote', { status: 503, code: 'ATTESTATION_UNAVAILABLE', stage: 'attestation' });
  // Info is optional context (identity + the attested compose); the quote is the evidence.
  let app = null;
  try {
    const i = await agent(sock, 'GET', '/Info');
    let appCompose = null;
    try { appCompose = typeof i.tcb_info === 'string' && i.tcb_info ? JSON.parse(i.tcb_info).app_compose ?? null : (i.tcb_info?.app_compose ?? null); } catch { /* tcb_info withheld */ }
    app = { appId: i.app_id ?? null, instanceId: i.instance_id ?? null, appName: i.app_name ?? null, composeHash: i.compose_hash ?? null, osImageHash: i.os_image_hash ?? null, mrAggregated: i.mr_aggregated ?? null, appCompose };
  } catch { /* leave null */ }
  return {
    available: true,
    nonce,
    reportDataBinding: 'first 32 bytes of the quote report_data = sha256("' + REPORT_DATA_PREFIX + '" + nonce)',
    report_data: q.report_data ?? rd.toString('hex'),
    quote: q.quote,
    event_log: q.event_log ?? null,
    vm_config: q.vm_config ?? null,
    app,
    how_to_verify: 'npm run verify:server -- <this server base URL>  (fresh nonce, Intel TDX quote via dcap-qvl, debug off, report_data binds your nonce, sha256(app_compose) == MRCONFIGID, RTMR3 replay). Compare composeHash with the docker-compose.phala.yml you audited. This does not bind the TLS channel to the CVM.',
  };
}
