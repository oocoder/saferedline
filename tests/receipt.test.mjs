import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const w = new Wallet('0x' + '55'.repeat(32));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hex = (n) => 'ab'.repeat(n / 2);

async function receipt(over = {}) {
  const reqH = sha('req'), resH = sha('res'), model = 'org/model:7b';
  const signedText = `${model}:${reqH}:${resH}`;
  return {
    ok: true, verified: true, attestationVerified: true, completionRun: true, completionError: null,
    nonce: hex(64), model, signingAddresses: [w.address], composeHash: hex(64), mrtd: hex(96), rtmr3: hex(96), gatewayTlsFingerprint: hex(64),
    checks: [{ id: 'a', pass: true, informational: false }, { id: 'b', pass: true, informational: false }, { id: 'measurement_pinning', pass: false, informational: true }],
    requestSha256: reqH, responseSha256: resH, signedText, signature: await w.signMessage(signedText), signingAddress: w.address, ...over,
  };
}
const check = (r) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), 'receipt.json');
  fs.writeFileSync(f, typeof r === 'string' ? r : JSON.stringify(r));
  return spawnSync(process.execPath, ['scripts/verify_tee.mjs', '--check', f], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SAFEREDLINE_ENV_FILE: '/nonexistent' } });
};

describe('verify_tee --check (offline receipt consistency)', () => {
  test('consistent receipt passes and states what it cannot re-prove', async () => {
    const r = check(await receipt());
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /Verified \(receipt consistency only\): true/);
    assert.match(r.stdout, /NOT re-provable offline/);
  });
  test('attestation-only receipt is accepted', async () => {
    const r = check(await receipt({ completionRun: false, requestSha256: undefined, responseSha256: undefined, signedText: undefined, signature: undefined, signingAddress: undefined }));
    assert.equal(r.status, 0, r.stdout);
  });
  const bad = {
    'tampered signed text (hash swap)': async () => receipt({ signedText: `org/model:7b:${sha('x')}:${sha('res')}` }),
    'signature from a different key': async () => receipt({ signature: await new Wallet('0x' + '66'.repeat(32)).signMessage((await receipt()).signedText) }),
    'signer not in attested list': async () => receipt({ signingAddresses: [new Wallet('0x' + '77'.repeat(32)).address] }),
    'request hash not matching signed text': async () => receipt({ requestSha256: sha('other') }),
    'malformed nonce': async () => receipt({ nonce: 'xyz' }),
    'a counted check failed': async () => { const r = await receipt(); r.checks[0].pass = false; return r; },
    'verified flag lies': async () => { const r = await receipt(); r.checks[1].pass = false; return r; },
    'bad measurement length': async () => receipt({ mrtd: 'abcd' }),
    'not a successful run': async () => receipt({ ok: false }),
  };
  for (const [name, mk] of Object.entries(bad)) {
    test(`rejects: ${name}`, async () => {
      const r = check(await mk());
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /Verified \(receipt consistency only\): false/);
    });
  }
  test('unreadable receipt: clear failure, no stack', () => {
    const r = check('not json');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAILED READ/);
    assert.doesNotMatch(r.stdout + r.stderr, /node:internal/);
  });
});
