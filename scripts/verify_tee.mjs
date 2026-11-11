#!/usr/bin/env node
// Proof run: full TEE attestation, then (with a key) one private completion + response-signature check,
// both sent over the SAME pinned TLS channel the app uses (certificate must match the attested gateway key).
//   npm run verify                    # human-readable
//   npm run verify -- --attest-only   # no API key needed
//   node scripts/verify_tee.mjs --check receipt.json   # re-validate a saved receipt OFFLINE (internal consistency only)
//   npm run prove                     # --json: machine-readable transcript on stdout (text goes to stderr)
import crypto from 'node:crypto';
import fs from 'node:fs';
import { verifyMessage } from 'ethers';
import { cfg, listTeeModels } from '../src/near.mjs';
import { attestModel, verifyResponseSignature, deps, canPin } from '../src/attest.mjs';

const { model: MODEL, apiKey: API_KEY } = cfg;
const json = process.argv.includes('--json');
const log = (...a) => (json ? console.error(...a) : console.log(...a));
const noKey = !API_KEY;
const attestOnly = process.argv.includes('--attest-only') || noKey;
const line = (c) => log(`  ${c.informational ? '\x1b[90mⓘ' : c.pass ? '\x1b[32m✔' : '\x1b[31m✘'}\x1b[0m ${c.label}  \x1b[2m${c.detail ?? ''}\x1b[0m`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const slim = (c) => ({ id: c.id, scope: c.scope, pass: c.pass, informational: !!c.informational });

/** Offline receipt re-validation: internal consistency only. Prints what it can and cannot re-prove. */
function checkReceipt(file) {
  const out = [];
  const ok = (name, pass, detail = '') => out.push({ name, pass, detail });
  let r;
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`FAILED READ: cannot read/parse ${file} (${String(e.message).split('\n')[0]})\nVerified: false`); process.exit(1); }
  const hex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`, 'i').test(v);
  ok('receipt is a successful run (ok:true)', r.ok === true);
  ok('nonce is 64 hex chars', hex(r.nonce, 64), String(r.nonce).slice(0, 16) + '…');
  const checks = Array.isArray(r.checks) ? r.checks : [];
  const counted = checks.filter((c) => !c.informational);
  ok('all counted checks passed', counted.length > 0 && counted.every((c) => c.pass === true), `${counted.filter((c) => c.pass).length}/${counted.length}`);
  ok('verified flag agrees with the checks', r.verified === (r.attestationVerified && counted.every((c) => c.pass) && (!r.completionRun || !r.completionError)));
  ok('measurements well-formed (mrtd/rtmr3 96 hex, composeHash/TLS fingerprint 64 hex)', hex(r.mrtd, 96) && hex(r.rtmr3, 96) && hex(r.composeHash, 64) && hex(r.gatewayTlsFingerprint, 64));
  ok('enclave signer list present', Array.isArray(r.signingAddresses) && r.signingAddresses.length > 0 && r.signingAddresses.every((a) => /^0x[0-9a-f]{40}$/i.test(a)));
  if (r.completionRun) {
    ok('request/response hashes well-formed (sha256 hex)', hex(r.requestSha256, 64) && hex(r.responseSha256, 64));
    const parts = String(r.signedText ?? '').split(':'); const resH = parts.pop(); const reqH = parts.pop(); const m = parts.join(':');
    ok('signed text = <model>:<requestSha256>:<responseSha256> as listed', m === r.model && reqH === r.requestSha256 && resH === r.responseSha256);
    let rec = '';
    try { rec = verifyMessage(r.signedText, r.signature); } catch { /* invalid */ }
    ok('signature recovers (EIP-191) to the listed signer', !!rec && rec.toLowerCase() === String(r.signingAddress).toLowerCase(), rec);
    ok('that signer is one of the attested enclave signers', (r.signingAddresses || []).some((a) => a.toLowerCase() === String(r.signingAddress).toLowerCase()));
  } else {
    out.push({ name: 'completion + signature', pass: true, detail: 'not in this receipt (attestation-only run)' });
  }
  const good = out.every((o) => o.pass);
  for (const o of out) console.log(`  ${o.pass ? '\x1b[32m✔' : '\x1b[31m✘'}\x1b[0m ${o.name}  \x1b[2m${o.detail}\x1b[0m`);
  console.log('\nRe-proven OFFLINE: the receipt is internally consistent (field formats, counted checks, hashes and signature agree, signer is in the attested list).');
  console.log('NOT re-provable offline: that the Intel TDX quote and collateral are genuine, that NVIDIA NRAS signed the GPU verdict, that the TLS certificate matched,');
  console.log('that the nonce was fresh (only you know which nonce you chose), or that the request reached the enclave. Those need the live run (npm run verify).');
  console.log(`\nVerified (receipt consistency only): ${good}`);
  process.exit(good ? 0 : 1);
}

function fail(e) {
  const code = e?.code && typeof e.code === 'string' ? e.code : (e?.name === 'TypeError' ? 'NETWORK' : 'ERROR');
  const message = String(e?.message || e).split('\n')[0].slice(0, 300) + (e?.cause?.code ? ` (${e.cause.code})` : '');
  log(`\n\x1b[31mFAILED ${code}: ${message}\x1b[0m`);
  log('\n──────── Summary ────────');
  log('Verified:        false');
  if (json) console.log(JSON.stringify({ ok: false, verified: false, error: { code, message } }, null, 2));
  process.exit(1);
}

async function run() {
  const tee = await listTeeModels();
  log(`\nConfidential TEE models available (owned_by=nearai): ${tee.map((m) => m.id).join(', ')}`);
  log(`Using: ${MODEL}\n`);

  log('1) Attestation (fresh nonce, Intel TDX + NVIDIA GPU + TLS binding)');
  const att = await attestModel(MODEL, API_KEY);
  att.checks.forEach(line);
  log(`  TCB status: ${att.tcbStatus}`);

  let completionError = null, sigOk = true, ran = false, hashes = null, sigChecks = [], sigInfo = null;
  if (!attestOnly && att.verified) {
    ran = true;
    log('\n2) Private completion inside the TEE (pinned TLS)');
    const requestBody = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'In one sentence: what is a mutual NDA?' }], max_tokens: 120, chat_template_kwargs: { enable_thinking: false } });
    const url = `${deps.baseUrl}/chat/completions`;
    const opts = { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body: requestBody, signal: AbortSignal.timeout(90000) };
    const pin = canPin(url) ? att.gatewayTlsFingerprint : null;
    let res, responseBody;
    try {
      res = pin ? await deps.pinnedFetch(url, opts, pin) : await deps.fetch(url, opts);
      responseBody = Buffer.from(await res.arrayBuffer()); // exact bytes the enclave signs
    } catch (e) {
      completionError = e.code === 'TLS_PIN_MISMATCH' ? 'TLS certificate does not match the attested gateway — request NOT sent' : 'request failed';
    }
    if (!completionError && !res.ok) completionError = `HTTP ${res.status}`;
    if (completionError) { log(`  \x1b[31m✘ ${completionError}\x1b[0m`); sigOk = false; } else {
      const body = JSON.parse(responseBody.toString('utf8').replace(/^\uFEFF/, ''));
      log(`  → "${body.choices[0].message.content.trim()}"`);
      log('\n3) Response signature (enclave-signed request/response hashes)');
      const sig = await verifyResponseSignature({ chatId: body.id, model: MODEL, requestBody, responseBody, apiKey: API_KEY, attestedSigners: att.signingAddresses, pin });
      sig.checks.forEach(line);
      sigOk = sig.verified; sigChecks = sig.checks;
      sigInfo = { model: MODEL, signedText: sig.text, signature: sig.signature, signingAddress: sig.signingAddress };
      hashes = { requestSha256: sha(Buffer.from(requestBody)), responseSha256: sha(responseBody) };
    }
  } else if (!attestOnly) {
    sigOk = false;
    log('\n(attestation did not verify: completion NOT sent)');
  } else {
    log(`\n(skipping completion: ${noKey ? 'no API key' : '--attest-only'})`);
  }

  const counted = att.checks.filter((c) => !c.informational);
  const info = att.checks.filter((c) => c.informational);
  const verified = att.verified && sigOk;
  log('\n──────── Summary ────────');
  log(`Counted checks:  ${counted.filter((c) => c.pass).length}/${counted.length} passed`);
  log(`Informational:   ${info.length ? info.map((c) => `${c.id} (${c.pass ? 'ok' : 'not satisfied'}: ${c.detail})`).join('; ') : 'none'}`);
  log(ran ? `Verified:        ${verified}` : `Verified (attestation only): ${att.verified}`);
  log(ran ? 'Completion + signature: verified over pinned TLS' : `Completion + signature: SKIPPED (${noKey ? 'no API key' : '--attest-only'})`);
  log(`Nonce:           ${att.nonce}`);
  log(`Model ID:        ${att.model}`);
  log(`Enclave signers: ${att.signingAddresses.join(', ')}`);
  log(`Compose hash:    ${att.composeHash}`);
  log(`MRTD:            ${att.measurement?.mrtd}`);
  log(`RTMR3:           ${att.measurement?.rtmr3}`);
  log(`TLS fingerprint: ${att.gatewayTlsFingerprint}`);
  log(`Hardware:        ${att.hardware}`);
  log(`Verified at:     ${att.verifiedAt}\n`);

  if (json) {
    console.log(JSON.stringify({
      ok: true, verified, attestationVerified: att.verified, completionRun: ran, completionError,
      nonce: att.nonce, model: att.model, signingAddresses: att.signingAddresses, gatewaySigningAddress: att.gatewaySigningAddress,
      composeHash: att.composeHash, mrtd: att.measurement?.mrtd ?? null, rtmr3: att.measurement?.rtmr3 ?? null, mrConfigId: att.measurement?.mrConfigId ?? null,
      tcbStatus: att.tcbStatus, gpuCount: att.gpuCount, gatewayTlsFingerprint: att.gatewayTlsFingerprint, verifiedAt: att.verifiedAt,
      checks: [...att.checks, ...sigChecks].map(slim), ...(hashes || {}), ...(sigInfo || {}),
    }, null, 2));
  }
  process.exit(verified ? 0 : 1);
}

const ci = process.argv.indexOf('--check');
if (ci >= 0) checkReceipt(process.argv[ci + 1] || 'receipt.json');
else run().catch(fail);
