#!/usr/bin/env node
// Verify a running SafeRedline server's OWN attestation (dstack CVM, Intel TDX):
//   npm run verify:server -- https://demo.example.org
// Fetches /api/server-attestation with a fresh nonce and checks the quote offline-verifiably with dcap-qvl
// (Intel root of trust + TCB), debug off, report_data binds OUR nonce, sha256(app_compose) in MRCONFIGID, RTMR3 replay.
import crypto from 'node:crypto';
import { verifyServerQuote } from '../src/attest.mjs';
import { reportDataFor } from '../src/dstack.mjs';

const base = (process.argv.slice(2).find((a) => !a.startsWith('--')) || '').replace(/\/+$/, '');
const json = process.argv.includes('--json');
const log = (...a) => (json ? console.error(...a) : console.log(...a));
const line = (c) => log(`  ${c.informational ? '\x1b[90mⓘ' : c.pass ? '\x1b[32m✔' : '\x1b[31m✘'}\x1b[0m ${c.label}  \x1b[2m${c.detail ?? ''}\x1b[0m`);

function die(code, message) {
  log(`\n\x1b[31mFAILED ${code}: ${message}\x1b[0m\n\nVerified: false`);
  if (json) console.log(JSON.stringify({ ok: false, verified: false, error: { code, message } }, null, 2));
  process.exit(1);
}

if (!/^https?:\/\//.test(base)) die('USAGE', 'usage: npm run verify:server -- <baseUrl>   e.g. https://demo.example.org');

try {
  const nonce = crypto.randomBytes(32).toString('hex');
  const res = await fetch(`${base}/api/server-attestation?nonce=${nonce}`, { signal: AbortSignal.timeout(30000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) die(body?.error?.code || `HTTP_${res.status}`, body?.error?.message || `HTTP ${res.status}`);
  if (!body?.available) die('NOT_ATTESTED', body?.reason || 'server reports no attestation');
  log(`Server attestation from ${base}\nNonce: ${nonce}\n`);
  const v = await verifyServerQuote({ quote: body.quote, expectedReportData32: reportDataFor(nonce), eventLog: body.event_log, appCompose: body.app?.appCompose });
  v.checks.forEach(line);
  const counted = v.checks.filter((c) => !c.informational);
  log('\n──────── Summary ────────');
  log(`Counted checks:  ${counted.filter((c) => c.pass).length}/${counted.length} passed`);
  log(`Verified:        ${v.verified}`);
  log(`TCB status:      ${v.tcbStatus}`);
  log(`Compose hash:    ${v.composeHash ?? 'not returned'}   (compare with the docker-compose.phala.yml you audited)`);
  log(`MRTD:            ${v.measurement?.mrtd}`);
  log('Not proven here: the TLS connection is not bound to the CVM; the compose hash is identified, not audited.\n');
  if (json) console.log(JSON.stringify({ ok: true, verified: v.verified, nonce, tcbStatus: v.tcbStatus, composeHash: v.composeHash, measurement: v.measurement, checks: v.checks.map((c) => ({ id: c.id, pass: c.pass, informational: !!c.informational })) }, null, 2));
  process.exit(v.verified ? 0 : 1);
} catch (e) {
  die(e?.code && typeof e.code === 'string' ? e.code : 'ERROR', String(e?.message || e).split('\n')[0] + (e?.cause?.code ? ` (${e.cause.code})` : ''));
}
