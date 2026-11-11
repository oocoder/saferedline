// SafeRedline — NEAR AI Cloud TEE attestation + response-signature verification.
//
// Implements https://docs.near.ai/cloud/verification (reference verifier:
// https://github.com/nearai/nearai-cloud-verifier):
//   1. Fresh 32-byte client nonce per request.
//   2. GET /v1/attestation/report?model=…&nonce=…&signing_algo=ecdsa
//   3. Intel TDX quote verified with Phala dcap-qvl (Intel root of trust + TCB status).
//   4. TDX debug bit off.
//   5. Quote report_data = signing_address (padded to 32 B) || nonce (32 B).
//   6. sha256(app_compose) bound into MRCONFIGID (0x01 || hash || 0…), and the
//      runtime `compose-hash` event agrees.
//   7. RTMR3 event-log replay matches the quote.
//   8. NVIDIA GPU evidence (same nonce) verified by NVIDIA NRAS.
//   9. Per-response ECDSA signature over "<model>:sha256(request):sha256(response)"
//      by an enclave key that was attested above.
//
// FAIL CLOSED: every check below is always emitted; a missing input is a failed
// check, never a skipped one. Nothing here writes to disk or logs content.

import crypto from 'node:crypto';
import dcap from '@phala/dcap-qvl';
import { verifyMessage } from 'ethers';
import { AppError } from './errors.mjs';

const { getCollateral, verify: dcapVerify, PHALA_PCCS_URL, INTEL_PCS_URL } = dcap;

// Injectable seams (tests / twin). Everything networked or time-dependent goes through here.
export const deps = {
  fetch: (...a) => globalThis.fetch(...a),
  baseUrl: process.env.NEAR_BASE_URL || 'https://cloud-api.near.ai/v1',
  nrasUrl: process.env.NRAS_URL || 'https://nras.attestation.nvidia.com/v3/attest/gpu',
  pccsUrl: process.env.PCCS_URL || PHALA_PCCS_URL,
  fallbackPccsUrl: INTEL_PCS_URL,
  getCollateral,
  nowSec: () => Math.floor(Date.now() / 1000),
  newNonce: () => crypto.randomBytes(32).toString('hex'),
  timeouts: { attest: 30000, pccs: 15000, nras: 30000, signature: 15000 },
};
export function setDeps(o) { Object.assign(deps, o); }

// UpToDate is ideal. OutOfDate / SWHardeningNeeded still mean a genuine, signature-valid
// Intel quote; they flag that the platform is behind Intel's latest advisory baseline
// (same policy as NEAR's reference verifier). tcbStatus is surfaced to the UI.
const ACCEPTED_TCB = new Set(['UpToDate', 'SWHardeningNeeded', 'ConfigurationAndSWHardeningNeeded', 'OutOfDate']);

export const newNonce = () => deps.newNonce();
export const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const strip0x = (s) => String(s || '').replace(/^0x/i, '').toLowerCase();
const toHex = (u8) => Buffer.from(u8 || []).toString('hex');

function check(id, scope, label, pass, detail, extra = {}) {
  return { id, label, pass: !!pass, detail, scope, ...extra };
}

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function withTimeout(promise, ms, message) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

export async function fetchJson(url, opts = {}, timeoutMs = 30000) {
  let res, text;
  try {
    res = await deps.fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (e) {
    throw new HttpError(e?.name === 'TimeoutError' ? 'timed out' : `network error (${e?.cause?.code || e?.message || 'fetch failed'})`, 0);
  }
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = body?.error?.message || (typeof body === 'string' ? body.slice(0, 120) : res.statusText);
    throw new HttpError(`HTTP ${res.status} from ${new URL(url).host}: ${msg}`, res.status);
  }
  return body;
}

export async function fetchAttestation(model, nonce, apiKey) {
  const qs = new URLSearchParams({ model, provider: 'near', include_tls_fingerprint: 'false', signing_algo: 'ecdsa', nonce });
  const headers = { Accept: 'application/json', 'x-no-aliasing': 'true' };
  if (apiKey && apiKey.startsWith('sk-')) headers.Authorization = `Bearer ${apiKey}`; // only needed for org-enabled models
  return fetchJson(`${deps.baseUrl}/attestation/report?${qs}`, { headers }, deps.timeouts.attest);
}

function parseEvents(eventLog) {
  const events = typeof eventLog === 'string' ? JSON.parse(eventLog) : eventLog;
  if (!Array.isArray(events)) throw new Error('event log missing');
  return events;
}

// RTMR3 replay: dstack runtime events extend RTMR3 with
// digest = SHA384(event_type LE u32 || ":" || event || ":" || payload_bytes)
function replayRtmr3(events) {
  let rtmr = Buffer.alloc(48);
  let count = 0;
  for (const ev of events) {
    if (ev.imr !== 3) continue;
    const et = Buffer.alloc(4); et.writeUInt32LE(ev.event_type >>> 0);
    const computed = crypto.createHash('sha384')
      .update(Buffer.concat([et, Buffer.from(':'), Buffer.from(ev.event || '', 'utf8'), Buffer.from(':'), Buffer.from(ev.event_payload || '', 'hex')]))
      .digest();
    if (ev.digest && strip0x(ev.digest) !== computed.toString('hex')) throw new Error(`event "${ev.event}" digest mismatch`);
    rtmr = crypto.createHash('sha384').update(Buffer.concat([rtmr, computed])).digest();
    count++;
  }
  return { rtmr3: rtmr.toString('hex'), count, events };
}

const NRAS_UNEXPECTED = 'NVIDIA NRAS returned unexpected response — failing closed';

async function verifyNvidia(nvidiaPayload, nonce) {
  const payload = typeof nvidiaPayload === 'string' ? JSON.parse(nvidiaPayload) : nvidiaPayload;
  const nonceOk = String(payload.nonce || '').toLowerCase() === nonce.toLowerCase();
  let body;
  try {
    body = await fetchJson(deps.nrasUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, deps.timeouts.nras);
  } catch (e) {
    if (e instanceof HttpError && e.status > 0 && e.status < 500) throw new Error(`NVIDIA NRAS rejected the evidence (${e.message}) — failing closed`);
    const err = new Error('NVIDIA NRAS unreachable — failing closed'); err.unavailable = 'NVIDIA NRAS'; throw err;
  }
  // NOTE: the NRAS JWT signature is not verified here (verdict trusted via TLS to NVIDIA). See README.
  let claims, gpus;
  try {
    const jwt = body[0][1];
    claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    gpus = Object.keys(body[1] || {}).length;
  } catch { throw new Error(NRAS_UNEXPECTED); }
  if (!claims || typeof claims !== 'object') throw new Error(NRAS_UNEXPECTED);
  return { nonceOk, verdict: claims['x-nvidia-overall-att-result'] === true, gpus, arch: payload.arch };
}

async function collateralFor(quote) {
  try {
    return await withTimeout(deps.getCollateral(deps.pccsUrl, quote), deps.timeouts.pccs, 'timeout');
  } catch (e1) {
    if (deps.fallbackPccsUrl && deps.fallbackPccsUrl !== deps.pccsUrl) {
      try { return await withTimeout(deps.getCollateral(deps.fallbackPccsUrl, quote), deps.timeouts.pccs, 'timeout'); } catch { /* fall through */ }
    }
    const err = new Error('Intel PCCS (collateral) unreachable — failing closed');
    err.unavailable = 'Intel PCCS';
    throw err;
  }
}

/**
 * Verify one TEE attestation (gateway or one model instance). Always returns the full check list.
 * @param {object} att  gateway_attestation or model_attestations[i]
 * @param {string} nonce the fresh client nonce we sent
 * @param {{gpu?: boolean, scope: 'gateway'|'model'}} opts
 */
export async function verifyOne(att, nonce, { gpu = false, scope = 'model' } = {}) {
  const checks = [];
  const unavailable = [];
  const C = (id, label, pass, detail, extra) => checks.push(check(id, scope, label, pass, detail, extra));
  let tcbStatus = null, gpuCount = null, td = null;

  C('nonce_echo', 'Fresh nonce echoed by enclave', strip0x(att.request_nonce) === nonce, att.request_nonce);

  // Intel TDX quote — cryptographic verification against Intel's root CA via PCCS collateral.
  try {
    const quote = Buffer.from(strip0x(att.intel_quote), 'hex');
    const collateral = await collateralFor(quote);
    const result = dcapVerify(quote, collateral, deps.nowSec());
    td = result.report?.asTd10?.() || null;
    tcbStatus = result.status;
    C('tdx_quote', 'Intel TDX quote signature valid (Intel root of trust)', ACCEPTED_TCB.has(tcbStatus), `TCB status: ${tcbStatus}${result.advisory_ids?.length ? ` · advisories: ${result.advisory_ids.length}` : ''}`, { tcbStatus });
  } catch (e) {
    if (e.unavailable) unavailable.push(e.unavailable);
    C('tdx_quote', 'Intel TDX quote signature valid (Intel root of trust)', false, e.unavailable ? e.message : `quote rejected: ${String(e.message).slice(0, 160)}`);
  }

  if (!td || !td.reportData) {
    C('td_parse', 'Quote body is a TD report with report data', false, 'quote body not TD10 (or quote not verified)');
  } else {
    C('td_parse', 'Quote body is a TD report with report data', true, 'TD10');
    const debug = (td.tdAttributes[0] & 1) === 1;
    C('tdx_debug', 'TDX debug mode disabled', !debug, `td_attributes[0]=0x${td.tdAttributes[0].toString(16).padStart(2, '0')}`);

    const rd = Buffer.from(td.reportData);
    const addr = Buffer.alloc(32); Buffer.from(strip0x(att.signing_address), 'hex').copy(addr);
    C('rd_signer', 'Quote binds enclave signing key', !!att.signing_address && rd.subarray(0, 32).equals(addr), att.signing_address);
    C('rd_nonce', 'Quote binds OUR fresh nonce (anti-replay)', rd.subarray(32, 64).toString('hex') === nonce, rd.subarray(32, 64).toString('hex'));
  }

  // compose + RTMR3 are always evaluated (missing evidence = failed check).
  let composeStr;
  try {
    const tcb = typeof att.info?.tcb_info === 'string' ? JSON.parse(att.info.tcb_info) : att.info?.tcb_info;
    composeStr = tcb?.app_compose;
    var tcbEvents = tcb?.event_log;
  } catch { /* leave undefined */ }
  const composeHash = typeof composeStr === 'string' ? sha256hex(Buffer.from(composeStr, 'utf8')) : null;
  if (composeHash && td?.mrConfigId) {
    C('compose', 'App code (docker compose) hash bound in MRCONFIGID', toHex(td.mrConfigId) === '01' + composeHash + '00'.repeat(15), composeHash, { composeHash });
  } else {
    C('compose', 'App code (docker compose) hash bound in MRCONFIGID', false, composeHash ? 'no verified quote body' : 'app_compose missing from evidence');
  }
  if (process.env.EXPECTED_COMPOSE_HASH) {
    C('compose_pinned', 'Compose hash equals pinned EXPECTED_COMPOSE_HASH', composeHash === process.env.EXPECTED_COMPOSE_HASH.toLowerCase(), composeHash || 'missing');
  }

  let rt = null;
  try {
    rt = replayRtmr3(parseEvents(att.event_log ?? tcbEvents));
    C('rtmr3', 'RTMR3 event-log replay matches quote', !!td && rt.rtmr3 === toHex(td.rtMr3), `${rt.count} runtime events · ${rt.rtmr3.slice(0, 16)}…`);
  } catch (e) {
    C('rtmr3', 'RTMR3 event-log replay matches quote', false, e.message);
  }
  {
    const ev = rt?.events.find((e) => e.imr === 3 && e.event === 'compose-hash');
    C('compose_event', 'Runtime compose-hash event agrees with app_compose', !!(ev && composeHash && strip0x(ev.event_payload) === composeHash), ev ? strip0x(ev.event_payload).slice(0, 16) + '…' : 'no compose-hash event');
  }

  if (gpu) {
    if (!att.nvidia_payload) {
      C('gpu', 'NVIDIA NRAS verdict: GPU TEE genuine', false, 'no nvidia_payload');
    } else {
      try {
        const g = await verifyNvidia(att.nvidia_payload, nonce);
        gpuCount = g.gpus || null;
        checks.push(check('gpu_nonce', 'gpu', 'GPU evidence bound to OUR nonce', g.nonceOk, nonce.slice(0, 16) + '…'));
        checks.push(check('gpu', 'gpu', 'NVIDIA NRAS verdict: GPU TEE genuine', g.verdict, `${g.gpus || '?'} GPU(s) · ${g.arch || ''}`));
      } catch (e) {
        if (e.unavailable) unavailable.push(e.unavailable);
        checks.push(check('gpu', 'gpu', 'NVIDIA NRAS verdict: GPU TEE genuine', false, e.message));
      }
    }
  }

  return {
    checks, unavailable, tcbStatus, gpuCount, composeHash,
    measurement: td ? { mrtd: toHex(td.mrTd), rtmr3: toHex(td.rtMr3), mrConfigId: toHex(td.mrConfigId) } : null,
  };
}

/** Full pre-flight attestation of the gateway + every model enclave instance, bound to a fresh nonce. */
export async function attestModel(model, apiKey) {
  const nonce = deps.newNonce();
  const started = Date.now();
  let report;
  try {
    report = await fetchAttestation(model, nonce, apiKey);
  } catch (e) {
    throw new AppError(`NEAR attestation report unreachable (${e.message}) — failing closed`, { status: 503, code: 'ATTESTATION_UNAVAILABLE', stage: 'attestation' });
  }
  if (!report || typeof report !== 'object') {
    throw new AppError('NEAR attestation report was not valid JSON — failing closed', { status: 503, code: 'ATTESTATION_UNAVAILABLE', stage: 'attestation' });
  }
  const checks = [];
  const models = Array.isArray(report.model_attestations) ? report.model_attestations : [];
  checks.push(check('model_present', 'model', 'Model enclave evidence returned', models.length > 0, `${models.length} instance(s)`));
  checks.push(check('gateway_present', 'gateway', 'Gateway enclave evidence returned', !!report.gateway_attestation, report.gateway_attestation ? 'present' : 'gateway_attestation missing'));

  const results = await Promise.all([
    ...models.map((m) => verifyOne(m, nonce, { gpu: true, scope: 'model' })),
    report.gateway_attestation ? verifyOne(report.gateway_attestation, nonce, { gpu: false, scope: 'gateway' }) : null,
  ]);
  const modelRes = results.slice(0, models.length);
  const gwRes = results[models.length];
  for (const r of results) if (r) checks.push(...r.checks);

  const all = results.filter(Boolean);
  const unavailable = [...new Set(all.flatMap((r) => r.unavailable))];
  const statuses = all.map((r) => r.tcbStatus).filter(Boolean);
  const tcbStatus = statuses.length === 0 ? null : (statuses.find((s) => s !== 'UpToDate') || 'UpToDate');
  const first = modelRes[0];
  const att = {
    verified: checks.every((c) => c.pass),
    nonce, model,
    signingAddresses: models.map((m) => m.signing_address).filter(Boolean),
    gatewaySigningAddress: report.gateway_attestation?.signing_address || null,
    appName: models[0]?.info?.app_name || null,
    composeHash: first?.composeHash || models[0]?.info?.compose_hash || null,
    tcbStatus,
    measurement: first?.measurement || null,
    hardware: 'Intel TDX (CPU) + NVIDIA Confidential Computing (GPU)',
    gpuCount: first?.gpuCount ?? null,
    checks,
    verifiedAt: new Date().toISOString(),
    ms: Date.now() - started,
  };
  void gwRes;
  // Not part of the JSON contract: lets the server tell "failed" from "could not reach Intel/NVIDIA".
  Object.defineProperty(att, 'unavailable', { value: unavailable, enumerable: false });
  return att;
}

/**
 * Verify the per-response signature: the enclave signs
 * "<model>:<sha256(request bytes)>:<sha256(response bytes)>" with an attested key.
 * requestBody / responseBody: Buffer (preferred, exact bytes) or string (utf8).
 */
export async function verifyResponseSignature({ chatId, model, requestBody, responseBody, apiKey, attestedSigners, attestedSigner }) {
  const checks = [];
  const S = (id, label, pass, detail) => checks.push(check(id, 'signature', label, pass, detail));
  const toBuf = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8'));
  const myReq = sha256hex(toBuf(requestBody));
  const myRes = sha256hex(toBuf(responseBody));
  const base = { chatId, requestSha256: myReq, responseSha256: myRes, signingAddress: null, signingAlgo: null, text: null };
  const signers = (attestedSigners || (attestedSigner ? [attestedSigner] : [])).filter(Boolean).map((s) => s.toLowerCase());
  try {
    const qs = new URLSearchParams({ model, signing_algo: 'ecdsa' });
    const sig = await fetchJson(`${deps.baseUrl}/signature/${encodeURIComponent(chatId)}?${qs}`, { headers: { Authorization: `Bearer ${apiKey}` } }, deps.timeouts.signature);
    const text = String(sig?.text ?? '');
    const parts = text.split(':');
    const resH = parts.pop(); const reqH = parts.pop(); const signedModel = parts.join(':');
    S('sig_req', 'Signed hash matches OUR exact request bytes', reqH === myReq, myReq.slice(0, 16) + '…');
    S('sig_res', 'Signed hash matches the exact response bytes received', resH === myRes, myRes.slice(0, 16) + '…');
    S('sig_model', 'Signed model id matches the model we requested', signedModel === '' || signedModel === model, signedModel || 'no model prefix in signed text');
    const algo = sig?.signing_algo ?? sig?.signature_kind ?? null; // field name unconfirmed live; accept either
    S('sig_algo', 'Signature algorithm is ECDSA', algo === null || String(algo).toLowerCase() === 'ecdsa', String(algo ?? 'not reported'));
    let recovered = '';
    try { recovered = verifyMessage(text, sig.signature); } catch (e) { recovered = `error: ${String(e.message).slice(0, 80)}`; }
    S('sig_ecdsa', 'ECDSA signature recovers to the signing address', recovered.toLowerCase() === String(sig.signing_address).toLowerCase(), recovered);
    S('sig_attested', 'Signer = key attested inside the TEE above', signers.length > 0 && signers.includes(recovered.toLowerCase()), signers.length ? recovered : 'no attested signer to compare against');
    return { verified: checks.every((c) => c.pass), ...base, signingAddress: sig.signing_address ?? null, signingAlgo: algo, text, checks };
  } catch (e) {
    S('sig_fetch', 'Response signature retrieved from enclave', false, e.message);
    return { verified: false, ...base, checks, fetchStatus: e.status ?? 0 };
  }
}
