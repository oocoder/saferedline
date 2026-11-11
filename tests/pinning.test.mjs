import test, { describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createTwin, wallet } from './twin/near-twin.mjs';
import { installTwin } from './twin/install.mjs';
import { deps, setDeps, makePinCheck, spkiSha256, attestModel } from '../src/attest.mjs';
import { cfg, setNearDeps, analyzeContract } from '../src/near.mjs';
import { fixture } from './twin/near-twin.mjs';
import { CONTRACT, SENTINEL } from './helpers.mjs';

// Self-signed localhost certificate generated per run (no key material is committed).
let key, cert, certDer, goodFp, https_twin, restoreTwin;
before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-tls-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  key = fs.readFileSync(path.join(dir, 'k.pem')); cert = fs.readFileSync(path.join(dir, 'c.pem'));
  certDer = new crypto.X509Certificate(cert).raw;
  goodFp = spkiSha256(certDer);
});
afterEach(async () => { await https_twin?.close(); https_twin = null; await restoreTwin?.(); restoreTwin = null; });

describe('makePinCheck (checkServerIdentity)', () => {
  const peer = () => ({ subject: { CN: 'localhost' }, subjectaltname: 'DNS:localhost', raw: certDer });
  test('matching SPKI + hostname passes', () => assert.equal(makePinCheck(goodFp)('localhost', peer()), undefined));
  test('matching is case-insensitive on the fingerprint', () => assert.equal(makePinCheck(goodFp.toUpperCase())('localhost', peer()), undefined));
  test('mismatching SPKI returns TLS_PIN_MISMATCH', () => {
    const e = makePinCheck('ee'.repeat(32))('localhost', peer());
    assert.equal(e.code, 'TLS_PIN_MISMATCH');
  });
  test('missing/empty attested fingerprint never passes', () => {
    assert.equal(makePinCheck('')('localhost', peer()).code, 'TLS_PIN_MISMATCH');
    assert.equal(makePinCheck(undefined)('localhost', peer()).code, 'TLS_PIN_MISMATCH');
  });
  test('hostname mismatch is rejected before the pin is consulted', () => {
    const e = makePinCheck(goodFp)('evil.example', peer());
    assert.ok(e instanceof Error); assert.notEqual(e.code, 'TLS_PIN_MISMATCH');
  });
});

describe('inference over a pinned TLS connection (https twin)', () => {
  async function setup(attestedFp) {
    const t = await installTwin({});
    restoreTwin = t.restore;
    https_twin = createTwin({ tls: { key, cert } });
    await https_twin.listen();
    setDeps({ baseUrl: https_twin.url, tlsOptions: { ca: cert } });
    setNearDeps({ // stand-in for a verified attestation that attests `attestedFp` as the gateway TLS key
      attest: async () => ({ verified: true, signingAddresses: [wallet.address], gatewayTlsFingerprint: attestedFp }),
    });
  }
  test('matching fingerprint: contract delivered, signature fetched over same pin, channel.tlsPinned', async () => {
    await setup(goodFp);
    const r = await analyzeContract(CONTRACT);
    assert.equal(r.verified, true);
    assert.deepEqual([r.channel.tlsPinned, r.channel.fingerprint], [true, goodFp]);
    assert.equal(https_twin.chatRequests, 1);
    assert.ok(https_twin.requests.some((x) => x.startsWith('GET /v1/signature/')));
  });
  test('mismatching fingerprint: ATTESTATION_FAILED, contractSent false, twin never receives a request', async () => {
    await setup('ee'.repeat(32));
    await assert.rejects(analyzeContract(CONTRACT), (e) => {
      assert.equal(e.code, 'ATTESTATION_FAILED'); assert.equal(e.contractSent, false); assert.equal(e.status, 502);
      assert.equal(e.message, 'TLS certificate does not match the attested gateway — contract NOT sent');
      assert.ok(!e.message.includes(SENTINEL));
      return true;
    });
    assert.equal(https_twin.chatRequests, 0);
    assert.deepEqual(https_twin.requests, [], 'handshake aborted before any HTTP request');
  });
  test('https endpoint with no attested fingerprint is reported unpinned', async () => {
    await setup(null);
    setDeps({ fetch: (u, o) => deps.pinnedFetch(u, o, goodFp) }); // plain fetch can't trust the test CA; route it through a CA-aware request
    const r = await analyzeContract(CONTRACT);
    assert.equal(r.channel.tlsPinned, false);
    assert.match(r.channel.note, /NOT pinned/);
  });
  test('untrusted certificate (no CA) is rejected by normal verification', async () => {
    await setup(goodFp);
    setDeps({ tlsOptions: {} });
    await assert.rejects(analyzeContract(CONTRACT), (e) => e.code === 'INFERENCE_FAILED');
    assert.equal(https_twin.chatRequests, 0);
  });
});

describe('plain-http twin and strict tls_bound', () => {
  test('twin (http): pinning reported as skipped, not pinned', async () => {
    const t = await installTwin({}); restoreTwin = t.restore;
    const r = await analyzeContract(CONTRACT);
    assert.equal(r.channel.tlsPinned, false);
    assert.match(r.channel.note, /skipped/);
  });
  test('tls_bound always counts toward verified (no opt-out)', async () => {
    const t = await installTwin({ realSigner: true }); restoreTwin = t.restore;
    setDeps({ getTlsFingerprint: async () => 'ee'.repeat(32) });
    const a = await attestModel(fixture.model, '');
    assert.equal(a.checks.find((c) => c.id === 'tls_bound').pass, false);
    assert.equal(a.checks.find((c) => c.id === 'tls_bound').informational, undefined);
    assert.equal(a.verified, false);
    process.env.TLS_BOUND_STRICT = '0'; // removed flag: ignored
    try { assert.equal((await attestModel(fixture.model, '')).verified, false); } finally { delete process.env.TLS_BOUND_STRICT; }
    assert.match(a.gatewayTlsFingerprint, /^[0-9a-f]{64}$/);
  });
});
