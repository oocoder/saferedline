// SafeRedline — NEAR AI Cloud TEE attestation + response-signature verification.
//
// Implements the procedure from https://docs.near.ai/cloud/verification and the
// reference verifier https://github.com/nearai/nearai-cloud-verifier:
//   1. Fresh 32-byte client nonce per request.
//   2. GET /v1/attestation/report?model=…&nonce=…&signing_algo=ecdsa
//   3. Intel TDX quote verified with Phala dcap-qvl (Intel root of trust + TCB status).
//   4. TDX debug bit off.
//   5. Quote report_data = signing_address (padded to 32 B) || nonce (32 B).
//   6. sha256(app_compose) bound into MRCONFIGID (0x01 || hash || 0…).
//   7. RTMR3 event-log replay matches the quote.
//   8. NVIDIA GPU evidence (same nonce) verified by NVIDIA NRAS.
//   9. Per-response ECDSA signature: sha256(request bytes):sha256(response bytes)
//      signed by the attested enclave key.
//
// Nothing in this module writes to disk or logs request/response content.

import crypto from 'node:crypto';
import { getCollateralAndVerify } from '@phala/dcap-qvl';
import { verifyMessage } from 'ethers';

export const NEAR_BASE = process.env.NEAR_BASE_URL || 'https://cloud-api.near.ai/v1';
const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
// UpToDate is ideal. OutOfDate / SWHardeningNeeded still mean a genuine, signature-valid
// Intel quote; they flag that the platform is behind Intel's latest advisory baseline
// (same policy as NEAR's reference verifier).
const ACCEPTED_TCB = new Set(['UpToDate', 'SWHardeningNeeded', 'ConfigurationAndSWHardeningNeeded', 'OutOfDate']);

export const newNonce = () => crypto.randomBytes(32).toString('hex');
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const strip0x = (s) => String(s || '').replace(/^0x/i, '').toLowerCase();
const toHex = (u8) => Buffer.from(u8).toString('hex');

function check(id, label, pass, detail, extra = {}) {
  return { id, label, pass: !!pass, detail, ...extra };
}

async function fetchJson(url, opts = {}, timeoutMs = 30000) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = body?.error?.message || (typeof body === 'string' ? body.slice(0, 200) : res.statusText);
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${msg}`);
  }
  return body;
}

export async function fetchAttestation(model, nonce, apiKey) {
  const qs = new URLSearchParams({ model, provider: 'near', include_tls_fingerprint: 'false', signing_algo: 'ecdsa', nonce });
  const headers = { Accept: 'application/json', 'x-no-aliasing': 'true' };
  if (apiKey && apiKey.startsWith('sk-')) headers.Authorization = `Bearer ${apiKey}`; // only needed for org-enabled models
  return fetchJson(`${NEAR_BASE}/attestation/report?${qs}`, { headers });
}

// RTMR3 replay: dstack runtime events extend RTMR3 with
// digest = SHA384(event_type LE u32 || ":" || event || ":" || payload_bytes)
function replayRtmr3(eventLog) {
  const events = typeof eventLog === 'string' ? JSON.parse(eventLog) : eventLog || [];
  let rtmr = Buffer.alloc(48);
  let count = 0;
  for (const ev of events) {
    if (ev.imr !== 3) continue;
    const et = Buffer.alloc(4); et.writeUInt32LE(ev.event_type >>> 0);
    const computed = crypto.createHash('sha384')
      .update(Buffer.concat([et, Buffer.from(':'), Buffer.from(ev.event || '', 'utf8'), Buffer.from(':'), Buffer.from(ev.event_payload || '', 'hex')]))
      .digest();
    if (ev.digest && strip0x(ev.digest) !== computed.toString('hex')) {
      throw new Error(`event "${ev.event}" digest mismatch`);
    }
    rtmr = crypto.createHash('sha384').update(Buffer.concat([rtmr, computed])).digest();
    count++;
  }
  return { rtmr3: rtmr.toString('hex'), count };
}

async function verifyNvidia(nvidiaPayload, nonce) {
  const payload = typeof nvidiaPayload === 'string' ? JSON.parse(nvidiaPayload) : nvidiaPayload;
  const nonceOk = String(payload.nonce || '').toLowerCase() === nonce.toLowerCase();
  const body = await fetchJson(NRAS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const jwt = body[0][1];
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  const gpus = Object.keys(body[1] || {}).length;
  return { nonceOk, verdict: claims['x-nvidia-overall-att-result'] === true, gpus, arch: payload.arch };
}

/**
 * Verify one TEE attestation (gateway or model). Returns a list of checks.
 * @param {object} att  one attestation object (gateway_attestation or model_attestations[i])
 * @param {string} nonce the fresh client nonce we sent
 * @param {{gpu?: boolean, prefix?: string}} opts
 */
export async function verifyOne(att, nonce, { gpu = false, prefix = '' } = {}) {
  const checks = [];
  const P = (s) => (prefix ? `${prefix}: ${s}` : s);

  checks.push(check('nonce_echo', P('Fresh nonce echoed by enclave'), strip0x(att.request_nonce) === nonce, att.request_nonce));

  // Intel TDX quote — cryptographic verification against Intel's root CA via PCCS collateral.
  let td = null;
  try {
    const result = await getCollateralAndVerify(Buffer.from(strip0x(att.intel_quote), 'hex'));
    td = result.report?.asTd10?.() || result.report?.data || result.report;
    const status = result.status;
    checks.push(check('tdx_quote', P('Intel TDX quote signature valid (Intel root of trust)'), ACCEPTED_TCB.has(status), `TCB status: ${status}${result.advisory_ids?.length ? ` · advisories: ${result.advisory_ids.length}` : ''}`, { tcbStatus: status }));
  } catch (e) {
    checks.push(check('tdx_quote', P('Intel TDX quote signature valid (Intel root of trust)'), false, e.message));
  }

  if (td && td.reportData) {
    const debug = (td.tdAttributes[0] & 1) === 1;
    checks.push(check('tdx_debug', P('TDX debug mode disabled'), !debug, `td_attributes[0]=0x${td.tdAttributes[0].toString(16).padStart(2, '0')}`));

    const rd = Buffer.from(td.reportData);
    const addr = Buffer.alloc(32); Buffer.from(strip0x(att.signing_address), 'hex').copy(addr);
    checks.push(check('rd_signer', P('Quote binds enclave signing key'), rd.subarray(0, 32).equals(addr), att.signing_address));
    checks.push(check('rd_nonce', P('Quote binds OUR fresh nonce (anti-replay)'), rd.subarray(32, 64).toString('hex') === nonce, rd.subarray(32, 64).toString('hex')));

    const compose = att.info?.tcb_info?.app_compose ?? (typeof att.info?.tcb_info === 'string' ? JSON.parse(att.info.tcb_info).app_compose : undefined);
    if (compose != null) {
      const h = sha256hex(Buffer.from(compose, 'utf8'));
      const mrc = toHex(td.mrConfigId);
      const expected = '01' + h + '00'.repeat(15);
      checks.push(check('compose', P('App code (docker compose) hash bound in MRCONFIGID'), mrc === expected, h, { composeHash: h }));
    }

    try {
      const { rtmr3, count } = replayRtmr3(att.event_log ?? att.info?.tcb_info?.event_log);
      checks.push(check('rtmr3', P('RTMR3 event-log replay matches quote'), rtmr3 === toHex(td.rtMr3), `${count} runtime events · ${rtmr3.slice(0, 16)}…`));
    } catch (e) {
      checks.push(check('rtmr3', P('RTMR3 event-log replay matches quote'), false, e.message));
    }
    td.mrtdHex = toHex(td.mrTd || []);
  }

  if (gpu) {
    if (!att.nvidia_payload) {
      checks.push(check('gpu', P('NVIDIA GPU confidential-computing attestation'), false, 'no nvidia_payload'));
    } else {
      try {
        const g = await verifyNvidia(att.nvidia_payload, nonce);
        checks.push(check('gpu_nonce', P('GPU evidence bound to OUR nonce'), g.nonceOk, nonce.slice(0, 16) + '…'));
        checks.push(check('gpu', P('NVIDIA NRAS verdict: GPU TEE genuine'), g.verdict, `${g.gpus || '?'} GPU(s) · ${g.arch || ''}`));
      } catch (e) {
        checks.push(check('gpu', P('NVIDIA NRAS verdict: GPU TEE genuine'), false, e.message));
      }
    }
  }

  return { checks, measurement: td ? { mrtd: td.mrtdHex, rtmr3: toHex(td.rtMr3 || []), mrConfigId: toHex(td.mrConfigId || []) } : null };
}

/**
 * Full pre-flight attestation of the gateway + model enclave, bound to a fresh nonce.
 */
export async function attestModel(model, apiKey) {
  const nonce = newNonce();
  const started = Date.now();
  const report = await fetchAttestation(model, nonce, apiKey);
  const modelAtt = (report.model_attestations || []).find((m) => !m.model_name || m.model_name === model) || report.model_attestations?.[0];
  const checks = [];
  if (!modelAtt) {
    checks.push(check('model_present', 'Model enclave evidence returned', false, 'no model_attestations in report'));
  }
  const [m, g] = await Promise.all([
    modelAtt ? verifyOne(modelAtt, nonce, { gpu: true, prefix: 'Model TEE' }) : { checks: [] },
    report.gateway_attestation ? verifyOne(report.gateway_attestation, nonce, { gpu: false, prefix: 'Gateway TEE' }) : { checks: [] },
  ]);
  checks.push(...m.checks, ...g.checks);
  return {
    nonce,
    model,
    signingAddress: modelAtt?.signing_address,
    gatewaySigningAddress: report.gateway_attestation?.signing_address,
    appName: modelAtt?.info?.app_name,
    composeHash: modelAtt?.info?.compose_hash,
    measurement: m.measurement,
    hardware: 'Intel TDX (CPU) + NVIDIA Confidential Computing (GPU)',
    checks,
    verified: checks.length > 0 && checks.every((c) => c.pass),
    verifiedAt: new Date().toISOString(),
    ms: Date.now() - started,
  };
}

/**
 * Verify the per-response signature: the enclave signs
 * "<model>:<sha256(request body)>:<sha256(response body)>" with its attested key.
 */
export async function verifyResponseSignature({ chatId, model, requestBody, responseBody, apiKey, attestedSigner }) {
  const checks = [];
  try {
    const qs = new URLSearchParams({ model, signing_algo: 'ecdsa' });
    const sig = await fetchJson(`${NEAR_BASE}/signature/${encodeURIComponent(chatId)}?${qs}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const parts = String(sig.text).split(':');
    const [reqH, resH] = parts.length === 3 ? [parts[1], parts[2]] : [parts[0], parts[1]];
    const myReq = sha256hex(Buffer.from(requestBody, 'utf8'));
    const myRes = sha256hex(Buffer.from(responseBody, 'utf8'));
    checks.push(check('sig_req', 'Signed hash matches OUR exact request bytes', reqH === myReq, myReq.slice(0, 16) + '…'));
    checks.push(check('sig_res', 'Signed hash matches the exact response bytes received', resH === myRes, myRes.slice(0, 16) + '…'));
    let recovered = '';
    try { recovered = verifyMessage(sig.text, sig.signature); } catch (e) { recovered = `error: ${e.message}`; }
    checks.push(check('sig_ecdsa', 'ECDSA signature recovers to the signing address', recovered.toLowerCase() === String(sig.signing_address).toLowerCase(), recovered));
    if (attestedSigner) {
      checks.push(check('sig_attested', 'Signer = key attested inside the TEE above', recovered.toLowerCase() === attestedSigner.toLowerCase(), attestedSigner));
    }
    return { checks, signatureKind: sig.signature_kind, signingAddress: sig.signing_address, text: sig.text };
  } catch (e) {
    checks.push(check('sig_fetch', 'Response signature retrieved from enclave', false, e.message));
    return { checks };
  }
}
