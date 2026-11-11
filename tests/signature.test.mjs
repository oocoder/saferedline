import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { verifyResponseSignature, setDeps, deps, sha256hex } from '../src/attest.mjs';

const w = new Wallet('0x' + '33'.repeat(32));
const other = new Wallet('0x' + '44'.repeat(32));
const MODEL = 'z-ai/glm-5.3-flash';
const saved = { fetch: deps.fetch };
afterEach(() => setDeps(saved));

// Stub the signature endpoint with an arbitrary signed text.
function stub({ text, signer = w, extra = {} }) {
  setDeps({ fetch: async () => new Response(JSON.stringify({ text, signature: await signer.signMessage(text), signing_address: signer.address, signing_algo: 'ecdsa', ...extra }), { status: 200 }) });
}
const args = (o = {}) => ({ chatId: 'c1', model: MODEL, requestBody: Buffer.from('{"a":1}'), responseBody: Buffer.from('{"b":2}'), apiKey: 'sk-x', attestedSigners: [w.address], ...o });
const good = (o = {}) => `${o.model ?? MODEL}:${sha256hex(o.req ?? Buffer.from('{"a":1}'))}:${sha256hex(o.res ?? Buffer.from('{"b":2}'))}`;
const failedIds = (r) => r.checks.filter((c) => !c.pass).map((c) => c.id);

describe('response signature', () => {
  test('ok', async () => {
    stub({ text: good() });
    const r = await verifyResponseSignature(args());
    assert.deepEqual(failedIds(r), []);
    assert.equal(r.verified, true);
    assert.equal(r.signingAlgo, 'ecdsa');
    for (const id of ['sig_req', 'sig_res', 'sig_ecdsa', 'sig_attested', 'sig_model']) assert.ok(r.checks.some((c) => c.id === id && c.pass), id);
  });
  test('wrong signer (not the attested key)', async () => {
    stub({ text: good(), signer: other });
    const r = await verifyResponseSignature(args());
    assert.equal(r.verified, false);
    assert.deepEqual(failedIds(r), ['sig_attested']);
  });
  test('tampered response bytes', async () => {
    stub({ text: good({ res: Buffer.from('{"b":3}') }) });
    assert.deepEqual(failedIds(await verifyResponseSignature(args())), ['sig_res']);
  });
  test('tampered request bytes', async () => {
    stub({ text: good({ req: Buffer.from('{"a":2}') }) });
    assert.deepEqual(failedIds(await verifyResponseSignature(args())), ['sig_req']);
  });
  test('model mismatch (#6)', async () => {
    stub({ text: good({ model: 'other/model' }) });
    assert.deepEqual(failedIds(await verifyResponseSignature(args())), ['sig_model']);
  });
  test('model id containing ":" parses correctly (#6)', async () => {
    const m = 'org/model:7b-fp8';
    stub({ text: good({ model: m }) });
    const r = await verifyResponseSignature(args({ model: m }));
    assert.deepEqual(failedIds(r), []);
  });
  test('regression #5: no attested signer FAILS sig_attested', async () => {
    stub({ text: good() });
    for (const none of [undefined, [], [null]]) {
      const r = await verifyResponseSignature(args({ attestedSigners: none }));
      assert.equal(r.verified, false);
      assert.ok(failedIds(r).includes('sig_attested'));
    }
  });
  test('non-ECDSA algorithm is rejected', async () => {
    stub({ text: good(), extra: { signing_algo: 'ed25519' } });
    assert.ok(failedIds(await verifyResponseSignature(args())).includes('sig_algo'));
  });
  test('non-ASCII request bytes are hashed exactly (#10)', async () => {
    const req = Buffer.from('{"t":"“quotes” — § é 𝒳"}', 'utf8');
    stub({ text: good({ req }) });
    assert.equal((await verifyResponseSignature(args({ requestBody: req }))).verified, true);
    // a string argument hashes as UTF-8 and agrees
    assert.equal((await verifyResponseSignature(args({ requestBody: req.toString('utf8') }))).verified, true);
  });
  test('BOM-prefixed response bytes are hashed untouched (#9)', async () => {
    const res = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"b":2}')]);
    stub({ text: good({ res }) });
    assert.equal((await verifyResponseSignature(args({ responseBody: res }))).verified, true);
    // what a text() decode would have produced does NOT match what the enclave signed
    assert.ok(failedIds(await verifyResponseSignature(args({ responseBody: Buffer.from('{"b":2}') }))).includes('sig_res'));
  });
  test('malformed signature text fails closed', async () => {
    stub({ text: 'garbage' });
    assert.equal((await verifyResponseSignature(args())).verified, false);
  });
  test('endpoint error yields sig_fetch failure with status', async () => {
    setDeps({ fetch: async () => new Response('{}', { status: 404 }) });
    const r = await verifyResponseSignature(args());
    assert.equal(r.verified, false);
    assert.equal(r.fetchStatus, 404);
    assert.deepEqual(failedIds(r), ['sig_fetch']);
  });
});
