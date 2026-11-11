import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boot, assertEnvelope } from './helpers.mjs';
import { fixture } from './twin/near-twin.mjs';
import { installTwin } from './twin/install.mjs';
import { verifyServerQuote } from '../src/attest.mjs';
import { reportDataFor } from '../src/dstack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NONCE = 'ab'.repeat(32);
const gw = fixture.report.gateway_attestation;
const tcb = typeof gw.info.tcb_info === 'string' ? JSON.parse(gw.info.tcb_info) : gw.info.tcb_info;
const eventLogStr = typeof gw.event_log === 'string' ? gw.event_log : JSON.stringify(gw.event_log);

let env, agentServer, restoreTwin;
afterEach(async () => {
  await env?.close(); env = null;
  await new Promise((r) => { if (!agentServer) return r(); agentServer.closeAllConnections(); agentServer.close(r); }); agentServer = null;
  await restoreTwin?.(); restoreTwin = null;
  delete process.env.DSTACK_SOCKET;
});

// Fake dstack guest agent: HTTP over a unix socket, recorded response shape (docs: sdk/curl/api.md).
async function fakeAgent({ quoteStatus = 200 } = {}) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dstk-')), 'dstack.sock');
  const calls = [];
  agentServer = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: b ? JSON.parse(b) : null });
      const json = (st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && req.url === '/GetQuote') {
        if (quoteStatus !== 200) return json(quoteStatus, { error: 'boom' });
        const rd = Buffer.alloc(64); Buffer.from(JSON.parse(b).report_data, 'hex').copy(rd);
        return json(200, { quote: gw.intel_quote, event_log: eventLogStr, report_data: rd.toString('hex'), vm_config: '{"os_image_hash":"00"}' });
      }
      if (req.method === 'GET' && req.url === '/Info') {
        return json(200, { app_id: 'aa', instance_id: 'bb', app_name: 'saferedline', compose_hash: 'cc', os_image_hash: 'dd', mr_aggregated: 'ee', tcb_info: JSON.stringify({ app_compose: tcb.app_compose }), app_cert: '' });
      }
      json(404, { error: 'no route' });
    });
  });
  await new Promise((r) => agentServer.listen(sock, r));
  process.env.DSTACK_SOCKET = sock;
  return { sock, calls };
}

describe('GET /api/server-attestation', () => {
  test('no dstack socket: 200 available:false, nothing secret', async () => {
    process.env.DSTACK_SOCKET = '/nonexistent/dstack.sock';
    env = await boot();
    const r = await env.get(`/api/server-attestation?nonce=${NONCE}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { available: false, reason: 'not running in a dstack CVM (local/twin)' });
  });
  test('nonce is required and validated (64 hex)', async () => {
    env = await boot();
    for (const q of ['', '?nonce=', '?nonce=xyz', `?nonce=${'g'.repeat(64)}`, `?nonce=${'ab'.repeat(31)}`]) {
      assertEnvelope(assert, await env.get(`/api/server-attestation${q}`), 'BAD_INPUT', 400, false);
    }
  });
  test('with an agent: quote requested with report_data = sha256(prefix+nonce); response has quote, event_log, app info', async () => {
    const { calls } = await fakeAgent();
    env = await boot();
    const r = await env.get(`/api/server-attestation?nonce=${NONCE.toUpperCase()}`);
    assert.equal(r.status, 200, r.raw.slice(0, 200));
    const j = r.json;
    assert.equal(j.available, true);
    assert.equal(j.nonce, NONCE);
    const want = crypto.createHash('sha256').update('saferedline-server-attestation:' + NONCE).digest('hex');
    assert.equal(calls.find((c) => c.url === '/GetQuote').body.report_data, want);
    assert.ok(j.report_data.startsWith(want));
    assert.equal(j.quote, gw.intel_quote);
    assert.equal(typeof j.event_log, 'string');
    assert.equal(j.app.appCompose, tcb.app_compose);
    assert.equal(j.app.appName, 'saferedline');
    assert.match(j.how_to_verify, /verify:server/);
    assert.deepEqual(calls.map((c) => c.url).sort(), ['/GetQuote', '/Info'], 'only quote + info are requested (never GetKey)');
    assert.ok(!/key|secret|token/i.test(Object.keys(j).concat(Object.keys(j.app)).join(',')), 'no secret-bearing fields');
  });
  test('agent failure: 503 ATTESTATION_UNAVAILABLE, no raw agent text leaked', async () => {
    await fakeAgent({ quoteStatus: 500 });
    env = await boot();
    const r = await env.get(`/api/server-attestation?nonce=${NONCE}`);
    assertEnvelope(assert, r, 'ATTESTATION_UNAVAILABLE', 503, false);
    assert.ok(!r.raw.includes('boom'));
  });
  test('hosted-demo: allowed, and rate limited per IP', async () => {
    await fakeAgent();
    env = await boot({ serverOpts: { hostedDemo: true, limits: { quote: 2 } } });
    assert.equal((await env.get(`/api/server-attestation?nonce=${NONCE}`)).status, 200);
    assert.equal((await env.get(`/api/server-attestation?nonce=${NONCE}`)).status, 200);
    assertEnvelope(assert, await env.get(`/api/server-attestation?nonce=${NONCE}`), 'RATE_LIMITED', 429, false);
    // quotes do not eat the analysis budget
    const sample = (await env.get('/api/samples')).json[1].text;
    assert.equal((await env.post('/api/analyze', { text: sample })).status, 200);
  });
});

describe('verifyServerQuote (recorded real TDX quote, offline)', () => {
  const run = async (over = {}) => {
    await restoreTwin?.(); // a test may call run() several times: don't leak the previous twin
    const t = await installTwin({}); restoreTwin = t.restore;
    const actualRd = Buffer.from(gw.report_data, 'hex').subarray(0, 32);
    return verifyServerQuote({ quote: gw.intel_quote, expectedReportData32: actualRd, eventLog: eventLogStr, appCompose: tcb.app_compose, ...over });
  };
  const failed = (v) => v.checks.filter((c) => !c.pass && !c.informational).map((c) => c.id);
  test('genuine quote + matching binding: all counted checks pass', async () => {
    const v = await run();
    assert.deepEqual(failed(v), []);
    assert.equal(v.verified, true);
    assert.ok(['tdx_quote', 'td_parse', 'tdx_debug', 'rd_binding', 'compose', 'rtmr3', 'compose_event'].every((id) => v.checks.some((c) => c.id === id && c.pass)));
  });
  test('a quote bound to a different nonce fails rd_binding (and only that)', async () => {
    const v = await run({ expectedReportData32: reportDataFor(NONCE) });
    assert.deepEqual(failed(v), ['rd_binding']);
    assert.equal(v.verified, false);
  });
  test('tampered app_compose fails compose; missing event_log/app_compose are informational, not silent passes', async () => {
    assert.ok(failed(await run({ appCompose: tcb.app_compose + ' ' })).includes('compose'));
    const v = await run({ appCompose: null, eventLog: null });
    assert.ok(v.checks.filter((c) => c.informational).map((c) => c.id).includes('compose'));
    assert.ok(v.checks.filter((c) => c.informational).map((c) => c.id).includes('rtmr3'));
  });
  test('flipped quote byte fails tdx_quote', async () => {
    const q = gw.intel_quote; const i = q.length - 40;
    assert.ok(failed(await run({ quote: q.slice(0, i) + (q[i] === '0' ? '1' : '0') + q.slice(i + 1) })).includes('tdx_quote'));
  });
});

describe('scripts/verify_server.mjs', () => {
  // async spawn: a sync spawn would block this process's event loop while the script talks to the in-process test server
  const run = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['scripts/verify_server.mjs', ...args], { cwd: ROOT, env: { ...process.env, SAFEREDLINE_ENV_FILE: '/nonexistent' } });
    let stdout = '', stderr = ''; c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  test('usage error, unreachable server and non-CVM server all fail cleanly (no stack)', async () => {
    let r = await run([]);
    assert.equal(r.status, 1); assert.match(r.stdout, /FAILED USAGE/);
    r = await run(['http://127.0.0.1:9']);
    assert.equal(r.status, 1); assert.match(r.stdout, /FAILED \S+:/); assert.match(r.stdout, /Verified: false/);
    process.env.DSTACK_SOCKET = '/nonexistent/dstack.sock';
    env = await boot();
    r = await run([env.base, '--json']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /NOT_ATTESTED/);
    assert.equal(JSON.parse(r.stdout).ok, false);
    assert.doesNotMatch(r.stdout + r.stderr, /node:internal|\n\s+at /);
  });
});
