import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, assertEnvelope, CONTRACT, SENTINEL } from './helpers.mjs';
import { setDeps } from '../src/attest.mjs';
import { setNearDeps, cfg, normalizeAnalysis, listTeeModels } from '../src/near.mjs';

let env;
afterEach(async () => { await env?.close(); env = null; });
const analyze = (text = CONTRACT) => env.post('/api/analyze', { text });

describe('POST /api/analyze happy paths', () => {
  test('ok: verified, normalized analysis, full contract shape', async () => {
    env = await boot();
    const r = await analyze();
    assert.equal(r.status, 200, r.raw.slice(0, 300));
    const j = r.json;
    assert.equal(j.verified, true);
    assert.equal(j.signature.verified, true);
    assert.equal(j.attestation.verified, true);
    assert.equal(j.analysisParseError, false);
    assert.equal(j.jsonMode, 'native');
    assert.deepEqual(j.retention, { persisted: false, enforcedBy: 'no write paths in src/; sentinel test tests/pipeline.test.mjs' });
    assert.equal(j.analysis.flagged_clauses[0].quoteFound, true);
    assert.equal(j.analysis.flagged_clauses[1].quoteFound, false);
    for (const k of ['chatId', 'requestSha256', 'responseSha256', 'signingAddress', 'signingAlgo', 'text', 'checks']) assert.ok(k in j.signature, k);
    assert.equal(j.signature.checks.every((c) => c.scope === 'signature'), true);
    assert.ok(j.ms >= 0 && 'usage' in j);
  });
  test('fenced json and think tags are parsed', async () => {
    for (const chat of ['fenced_json', 'think_tags']) {
      env = await boot({ script: { chat } });
      const r = await analyze();
      assert.equal(r.json.analysisParseError, false, chat);
      assert.equal(r.json.analysis.overall_risk, 'High');
      await env.close(); env = null;
    }
  });
  test('non_json model output: 200 with analysisParseError', async () => {
    env = await boot({ script: { chat: 'non_json' } });
    const r = await analyze();
    assert.equal(r.status, 200);
    assert.equal(r.json.analysisParseError, true);
    assert.equal(r.json.analysis.overall_risk, 'Unknown');
    assert.deepEqual(r.json.analysis.flagged_clauses, []);
    assert.equal(r.json.verified, true);
  });
  test('400 on response_format retries without it (#11)', async () => {
    env = await boot({ script: { chat: '400_response_format' } });
    const r = await analyze();
    assert.equal(r.status, 200);
    assert.equal(r.json.jsonMode, 'prompt-only');
    assert.equal(r.json.verified, true);
    assert.equal(env.twin.chatRequests, 2);
  });
  test('404 then ok signature is retried (#16)', async () => {
    env = await boot({ script: { signature: '404_then_ok' } });
    const r = await analyze();
    assert.equal(r.json.verified, true);
  });
  test('BOM-prefixed upstream body still verifies against raw bytes (#9)', async () => {
    env = await boot({ script: { chat: 'bom_body' } });
    const r = await analyze();
    assert.equal(r.status, 200, r.raw.slice(0, 200));
    assert.equal(r.json.verified, true);
  });
  test('non-ASCII contract (real sample file): ASCII-safe JSON on the wire, signature verifies (#10)', async () => {
    env = await boot();
    const sample = fs.readFileSync(new URL('../samples/sample_contractor_agreement.txt', import.meta.url), 'utf8');
    assert.ok(/[^\x00-\x7f]/.test(sample), 'sample must contain non-ASCII characters');
    const r = await analyze(sample);
    const [sent] = [...env.twin.store.values()];
    assert.ok(sent.req.every((b) => b < 0x80), 'request is pure ASCII');
    assert.ok(sent.req.toString('utf8').includes('\\u201c') && sent.req.toString('utf8').includes('\\u00fa'), 'curly quote and ú escaped');
    assert.equal(r.json.signature.verified, true);
    assert.equal(r.json.signature.checks.find((c) => c.id === 'sig_req').pass, true);
  });
  test('ASCII_SAFE_JSON off: raw UTF-8 on the wire also verifies', async () => {
    env = await boot();
    setNearDeps({ asciiSafe: false });
    const r = await analyze();
    const [sent] = [...env.twin.store.values()];
    assert.ok(sent.req.some((b) => b >= 0x80));
    assert.equal(r.json.verified, true);
  });
  test('/api/ask returns verified answer', async () => {
    env = await boot();
    const r = await env.post('/api/ask', { text: CONTRACT, question: 'What is the term?' });
    assert.equal(r.status, 200);
    assert.equal(r.json.verified, true);
    assert.match(r.json.answer, /Twin answer/);
    assert.ok(r.json.attestation && r.json.signature && r.json.model);
  });
});

describe('failures', () => {
  test('signature tampering is NOT an error: 200 with verified:false (#15)', async () => {
    for (const signature of ['tampered_res', 'tampered_req', 'wrong_signer', 'model_mismatch']) {
      env = await boot({ script: { signature } });
      const r = await analyze();
      assert.equal(r.status, 200, signature);
      assert.equal(r.json.verified, false, signature);
      assert.equal(r.json.signature.verified, false, signature);
      assert.equal(r.json.attestation.verified, true);
      await env.close(); env = null;
    }
  });
  test('signature 401 is not retried', async () => {
    env = await boot({ script: { signature: '401' } });
    const r = await analyze();
    assert.equal(r.json.verified, false);
    assert.equal(env.twin.requests.filter((x) => x.startsWith('GET /v1/signature/')).length, 1);
  });
  test('real fixture signer vs twin signature: natural wrong-signer', async () => {
    env = await boot({ realSigner: true });
    const r = await analyze();
    assert.equal(r.json.verified, false);
    assert.ok(r.json.signature.checks.some((c) => c.id === 'sig_attested' && !c.pass));
  });
  test('NEAR_AUTH on chat 401', async () => {
    env = await boot({ script: { chat: '401' } });
    assertEnvelope(assert, await analyze(), 'NEAR_AUTH', 502, true);
  });
  test('INFERENCE_FAILED on 500, on connection drop, on non-JSON 200 (#12, #13)', async () => {
    for (const chat of ['500', 'drop', 'non_json_body']) {
      env = await boot({ script: { chat } });
      const r = await analyze();
      assertEnvelope(assert, r, 'INFERENCE_FAILED', 502, true);
      assert.ok(!r.raw.includes(SENTINEL));
      assert.ok(!/JSON|Unexpected token/.test(r.json.error.message.replace('non-JSON', '')), 'no parser message leaked');
      await env.close(); env = null;
    }
  });
  test('INFERENCE_TIMEOUT when the model hangs (#13)', async () => {
    env = await boot({ script: { chat: 'hang' }, timeoutMs: 300 });
    const t0 = Date.now();
    assertEnvelope(assert, await analyze(), 'INFERENCE_TIMEOUT', 504, true);
    assert.ok(Date.now() - t0 < 8000);
  });
  test('NO_API_KEY: nothing attested, nothing sent', async () => {
    env = await boot({ apiKey: '' });
    assertEnvelope(assert, await analyze(), 'NO_API_KEY', 503, false);
    assert.equal(env.twin.chatRequests, 0);
  });
});

describe('attestation gate: contract is never sent unless attestation verified', () => {
  const cases = [
    ['tampered compose', { attestation: 'tampered_compose' }, 'ATTESTATION_FAILED', 502, true],
    ['missing gateway', { attestation: 'missing_gateway' }, 'ATTESTATION_FAILED', 502, true],
    ['NRAS bad shape', { nras: 'bad_shape' }, 'ATTESTATION_FAILED', 502, true],
    ['NEAR report 503', { attestation: '503' }, 'ATTESTATION_UNAVAILABLE', 503, false],
    ['NRAS 503', { nras: '503' }, 'ATTESTATION_UNAVAILABLE', 503, true],
  ];
  for (const [name, script, code, status, hasAtt] of cases) {
    test(`${name} -> ${code}, zero chat requests`, async () => {
      env = await boot({ script });
      const r = await analyze();
      assertEnvelope(assert, r, code, status, false);
      assert.equal(r.json.error.stage, 'attestation');
      assert.equal(!!r.json.attestation, hasAtt);
      if (hasAtt) assert.equal(r.json.attestation.verified, false);
      assert.equal(env.twin.chatRequests, 0, 'contract must not reach the chat endpoint');
      assert.ok(!r.raw.includes(SENTINEL));
    });
  }
  test('PCCS down -> ATTESTATION_UNAVAILABLE, zero chat requests', async () => {
    env = await boot();
    setDeps({ getCollateral: () => Promise.reject(new Error('ECONNREFUSED')), fallbackPccsUrl: null });
    const r = await analyze();
    assertEnvelope(assert, r, 'ATTESTATION_UNAVAILABLE', 503, false);
    assert.match(r.json.error.message, /PCCS/);
    assert.equal(env.twin.chatRequests, 0);
  });
  test('/api/ask is gated too', async () => {
    env = await boot({ script: { attestation: 'tampered_compose' } });
    const r = await env.post('/api/ask', { text: CONTRACT, question: 'q?' });
    assertEnvelope(assert, r, 'ATTESTATION_FAILED', 502, false);
    assert.equal(env.twin.chatRequests, 0);
  });
  test('/api/attest returns 200 with red checks when verification fails', async () => {
    env = await boot({ script: { attestation: 'tampered_compose' } });
    const r = await env.get('/api/attest');
    assert.equal(r.status, 200);
    assert.equal(r.json.verified, false);
    assert.ok(r.json.checks.some((c) => !c.pass));
    assert.equal(env.twin.chatRequests, 0);
  });
  test('/api/attest 503 only when the report cannot be fetched', async () => {
    env = await boot({ script: { attestation: '503' } });
    assertEnvelope(assert, await env.get('/api/attest'), 'ATTESTATION_UNAVAILABLE', 503, false);
  });
});

describe('zero retention (sentinel)', () => {
  test('contract text never appears in logs, error bodies, or fs writes', async () => {
    const logs = []; const writes = [];
    const origLog = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    for (const k of Object.keys(origLog)) console[k] = (...a) => logs.push(a.map(String).join(' '));
    const wrap = (obj, name) => { const o = obj[name]; obj[name] = (...a) => { writes.push(`${name}:${String(a[0])}`); return o.apply(obj, a); }; return () => { obj[name] = o; }; };
    const undo = [wrap(fs, 'writeFileSync'), wrap(fs, 'appendFileSync'), wrap(fs, 'createWriteStream'), wrap(fs.promises, 'writeFile'), wrap(fs.promises, 'appendFile')];
    const bodies = [];
    try {
      for (const script of [{}, { chat: 'non_json_body' }, { chat: '401' }, { chat: 'non_json' }, { attestation: 'tampered_compose' }, { signature: 'tampered_res' }]) {
        env = await boot({ script });
        bodies.push((await analyze()).raw);
        bodies.push((await env.post('/api/ask', { text: CONTRACT, question: `why ${SENTINEL}?` })).raw);
        await env.close(); env = null;
      }
      // malformed / oversized inputs must not echo content either
      env = await boot();
      bodies.push((await env.post('/api/analyze', `{"text":"${SENTINEL}`)).raw);
      bodies.push((await env.post('/api/analyze', { text: SENTINEL })).raw);
      bodies.push((await env.post('/api/analyze', { text: SENTINEL.repeat(60000) })).raw);
    } finally {
      undo.forEach((u) => u());
      Object.assign(console, origLog);
    }
    assert.ok(logs.length > 5, 'request metadata lines are logged');
    assert.ok(logs.every((l) => !l.includes(SENTINEL)), 'sentinel leaked into logs');
    assert.ok(logs.every((l) => /^(GET|POST) \/\S* \d{3} \d+ms$/.test(l)), 'only metadata-only log lines: ' + logs.find((l) => !/^(GET|POST) \/\S* \d{3} \d+ms$/.test(l)));
    assert.deepEqual(writes, [], 'no file writes');
    // success bodies legitimately echo a quoted clause; every non-success body must be sentinel-free
    for (const b of bodies) if (b.includes('"error"')) assert.ok(!b.includes(SENTINEL), b.slice(0, 200));
  });
});

describe('unit', () => {
  test('normalizeAnalysis coerces garbage (#14)', () => {
    const a = normalizeAnalysis({ overall_risk: 'Catastrophic', flagged_clauses: [null, { clause_title: 5, risk_level: 'Critical', original_text: 'a  b\nc' }], missing_protections: 'x' }, 'foo a b c bar');
    assert.equal(a.overall_risk, 'Unknown');
    assert.equal(a.flagged_clauses.length, 1);
    assert.equal(a.flagged_clauses[0].risk_level, 'Medium');
    assert.equal(a.flagged_clauses[0].quoteFound, true);
    assert.deepEqual(a.missing_protections, []);
    assert.deepEqual(normalizeAnalysis(null, '').flagged_clauses, []);
  });
  test('listTeeModels checks res.ok (#18)', async () => {
    env = await boot();
    setDeps({ fetch: async () => new Response('x', { status: 500 }) });
    await assert.rejects(listTeeModels(), (e) => e.code === 'INFERENCE_FAILED');
  });
});

describe('twin: sample-aware analyses', () => {
  const sampleText = (id) => fs.readFileSync(new URL(`../samples/${id}.txt`, import.meta.url), 'utf8');
  const expectations = [
    ['sample_predatory_nda', 'High', 5, 3],
    ['sample_balanced_nda', 'Low', 0, 1],
    ['sample_contractor_agreement', 'High', 7, 4],
  ];
  for (const [id, risk, flagged, missing] of expectations) {
    test(`${id}: ${risk}, ${flagged} flagged, every quote verbatim`, async () => {
      env = await boot();
      const r = await analyze(sampleText(id));
      assert.equal(r.status, 200);
      assert.equal(r.json.verified, true);
      const a = r.json.analysis;
      assert.equal(a.overall_risk, risk);
      assert.equal(a.flagged_clauses.length, flagged);
      assert.equal(a.missing_protections.length, missing);
      assert.ok(a.flagged_clauses.every((c) => c.quoteFound), 'all quotes appear verbatim: ' + a.flagged_clauses.filter((c) => !c.quoteFound).map((c) => c.clause_title));
      assert.ok(a.executive_summary.startsWith('[Simulated twin output] '));
    });
  }
  test('unrecognized text gets the prefixed generic analysis', async () => {
    env = await boot();
    const r = await analyze();
    assert.ok(r.json.analysis.executive_summary.startsWith('[Simulated twin output] '));
    assert.equal(r.json.analysis.flagged_clauses.length, 2);
  });
});
