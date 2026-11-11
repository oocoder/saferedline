#!/usr/bin/env node
// Phase 1 proof: one private completion + full TEE attestation, printed as a summary.
//   npm run verify            # attest + completion + response-signature check
//   npm run verify -- --attest-only   # no API key needed
import { cfg, listTeeModels } from '../src/near.mjs';
import { attestModel, verifyResponseSignature, deps } from '../src/attest.mjs';

const { model: MODEL, apiKey: API_KEY } = cfg;
const NEAR_BASE = deps.baseUrl;

const attestOnly = process.argv.includes('--attest-only') || !API_KEY;
const line = (c) => console.log(`  ${c.pass ? '\x1b[32m✔' : '\x1b[31m✘'}\x1b[0m ${c.label}  \x1b[2m${c.detail ?? ''}\x1b[0m`);

const tee = await listTeeModels();
console.log(`\nConfidential TEE models available (owned_by=nearai): ${tee.map((m) => m.id).join(', ')}`);
console.log(`Using: ${MODEL}\n`);

console.log('1) Attestation (fresh nonce, Intel TDX + NVIDIA GPU)');
const att = await attestModel(MODEL, API_KEY);
att.checks.forEach(line);
console.log(`  TCB status: ${att.tcbStatus}`);

let sigOk = true;
if (!attestOnly) {
  console.log('\n2) Private completion inside the TEE');
  const requestBody = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'In one sentence: what is a mutual NDA?' }], max_tokens: 120, chat_template_kwargs: { enable_thinking: false } });
  const res = await fetch(`${NEAR_BASE}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body: requestBody });
  const responseBody = Buffer.from(await res.arrayBuffer()); // exact bytes the enclave signs
  if (!res.ok) { console.log(`  \x1b[31m✘ HTTP ${res.status}\x1b[0m`); process.exit(1); }
  const body = JSON.parse(responseBody.toString('utf8'));
  console.log(`  → "${body.choices[0].message.content.trim()}"`);
  console.log('\n3) Response signature (enclave-signed request/response hashes)');
  const sig = await verifyResponseSignature({ chatId: body.id, model: MODEL, requestBody, responseBody, apiKey: API_KEY, attestedSigners: att.signingAddresses });
  sig.checks.forEach(line);
  sigOk = sig.verified;
} else {
  console.log('\n(skipping completion — no API key or --attest-only)');
}

console.log('\n──────── Summary ────────');
console.log(`Verified:        ${att.verified && sigOk}`);
console.log(`Nonce:           ${att.nonce}`);
console.log(`Model ID:        ${att.model}`);
console.log(`Enclave signers: ${att.signingAddresses.join(', ')}`);
console.log(`Compose hash:    ${att.composeHash}`);
console.log(`MRTD:            ${att.measurement?.mrtd}`);
console.log(`Hardware:        ${att.hardware}`);
console.log(`Verified at:     ${att.verifiedAt}\n`);
process.exit(att.verified && sigOk ? 0 : 1);
