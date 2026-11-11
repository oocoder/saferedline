#!/usr/bin/env node
// Record PUBLIC attestation evidence (report + Intel collateral + NVIDIA NRAS verdicts) into
// tests/fixtures/attestation.json so tests and `npm run twin` work offline.
// Needs no API key. Refuses to write unless the live verification passes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deps, setDeps, attestModel, sha256hex } from '../src/attest.mjs';

const MODEL = process.env.NEAR_MODEL || 'z-ai/glm-5.3-flash';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'attestation.json');

const rec = { tlsFingerprint: null, collateral: {}, nras: {}, jwks: null, report: null, nonce: null, recordedAt: null };
const realGetCollateral = deps.getCollateral;
const realFetch = deps.fetch;
const realNow = deps.nowSec;
const realNonce = deps.newNonce;
let nonce;
const realTls = deps.getTlsFingerprint;
setDeps({
  getTlsFingerprint: async (h, p) => (rec.tlsFingerprint = await realTls(h, p)),
  newNonce: () => (nonce = realNonce()),
  getCollateral: async (url, quote) => {
    const c = await realGetCollateral(url, quote);
    rec.collateral[sha256hex(quote)] = JSON.parse(JSON.stringify(c));
    return c;
  },
  fetch: async (url, opts = {}) => {
    const res = await realFetch(url, opts);
    const u = String(url);
    const clone = res.clone();
    if (u === deps.jwksUrl) {
      rec.jwks = JSON.parse(await clone.text());
    } else if (u.startsWith(deps.nrasUrl) && opts.method === 'POST') {
      rec.nras[sha256hex(Buffer.from(opts.body))] = JSON.parse(await clone.text());
    } else if (u.includes('/attestation/report')) {
      rec.report = JSON.parse(await clone.text());
    }
    return res;
  },
});
rec.recordedAt = realNow();
const att = await attestModel(MODEL, '');
rec.nonce = nonce;
for (const c of att.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} [${c.scope}] ${c.id}: ${c.detail}`);
if (!att.verified) { console.error('\nLive verification FAILED — refusing to write fixture.'); process.exit(1); }
// keep only the JWKS keys that signed the recorded NRAS tokens (the full set is ~200 keys)
const kids = new Set(Object.values(rec.nras).flatMap((b) => [b[0][1], ...Object.values(b[1])]).map((t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url')).kid));
rec.jwks = { keys: rec.jwks.keys.filter((k) => kids.has(k.kid)).map(({ x5c, ...k }) => k) };
if (!rec.jwks.keys.length) { console.error('JWKS did not contain the signing keys — refusing to write fixture.'); process.exit(1); }
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ model: MODEL, ...rec }));
console.log(`\nWrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB), ${att.checks.length} checks, tcb=${att.tcbStatus}`);
