// Digital twin of NEAR AI Cloud for offline tests and `npm run twin`.
// Serves the RECORDED real public attestation (tests/fixtures/attestation.json) and signs chat
// responses with a fixed test key. It is NOT a TEE: nothing it says is evidence of anything.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'attestation.json'), 'utf8'));
export const wallet = new Wallet('0x' + '11'.repeat(32));
export const otherWallet = new Wallet('0x' + '22'.repeat(32));
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

const CLEAN = (quote) => ({
  overall_risk: 'High',
  executive_summary: 'Twin summary: this simulated analysis shows the UI states. It is not real model output.',
  flagged_clauses: [{
    clause_title: 'Simulated clause', risk_level: 'High', original_text: quote,
    why_its_risky: 'Simulated: one-sided obligation with no mutuality.', suggested_redline: 'Each party shall bear its obligations equally and for a reasonable, fixed term.',
  }, {
    clause_title: 'Hallucinated clause', risk_level: 'Medium', original_text: 'This sentence is not in the contract.',
    why_its_risky: 'Simulated: exercises the "not found verbatim" tag.', suggested_redline: 'N/A',
  }],
  missing_protections: ['Simulated: mutual termination right', 'Simulated: liability cap'],
});

export function createTwin({ tls } = {}) {
  const twin = {
    script: {}, // { attestation, nras, chat, signature }
    chatRequests: 0, requests: [], store: new Map(), sigHits: new Map(), chatCalls: 0, counter: 0,
    url: '', nrasUrl: '', jwksUrl: '',
  };
  const server = (tls ? (h) => https.createServer(tls, h) : (h) => http.createServer(h))((req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      twin.requests.push(`${req.method} ${u.pathname}`);
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      const s = twin.script;
      try {
        if (req.method === 'GET' && u.pathname === '/v1/attestation/report') {
          const m = s.attestation || 'fixture';
          if (m === '503') return json(503, { error: { message: 'twin: attestation unavailable' } });
          if (m === 'hang') return;
          const rep = structuredClone(fixture.report);
          if (m === 'tampered_compose') {
            const t = rep.model_attestations[0].info.tcb_info;
            if (typeof t === 'string') { const o = JSON.parse(t); o.app_compose += ' '; rep.model_attestations[0].info.tcb_info = JSON.stringify(o); } else t.app_compose += ' ';
          }
          if (m === 'missing_gateway') delete rep.gateway_attestation;
          if (s.mutate) s.mutate(rep); // test hook: arbitrary tampering of the recorded report
          return json(200, rep);
        }
        if (req.method === 'GET' && u.pathname === '/jwks') return json(200, s.jwks === 'empty' ? { keys: [] } : fixture.jwks);
        if (req.method === 'POST' && u.pathname === '/nras') {
          const m = s.nras || 'fixture';
          if (m === '503') return json(503, { error: { message: 'twin: nras down' } });
          if (m === 'hang') return;
          if (m === 'bad_shape') return json(200, { unexpected: true });
          let hit = fixture.nras[sha256hex(body)];
          if (hit && m === 'bad_jwt_sig') { // flip a signature byte of the overall token
            const t = hit[0][1].split('.'); const sg = Buffer.from(t[2], 'base64url'); sg[5] ^= 1; t[2] = sg.toString('base64url');
            hit = structuredClone(hit); hit[0][1] = t.join('.');
          }
          if (hit && m === 'no_gpus') hit = [hit[0], {}];
          return hit ? json(200, hit) : json(404, { error: { message: 'twin: unknown nras payload' } });
        }
        if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
          twin.chatRequests++; twin.chatCalls++;
          const m = s.chat || 'ok';
          if (m === 'hang') return;
          if (m === 'drop') return req.socket.destroy();
          if (m === '401') return json(401, { error: { message: 'twin: bad key' } });
          if (m === '500') return json(500, { error: { message: 'twin: boom' } });
          const parsed = JSON.parse(body.toString('utf8'));
          if (m === '400_response_format' && parsed.response_format) return json(400, { error: { message: 'response_format json_object is not supported' } });
          const user = String(parsed.messages?.at(-1)?.content || '');
          const contract = user.replace(/^CONTRACT TEXT:\n\n/, '');
          const quote = (contract.split('\n').find((l) => l.trim().length > 40) || contract).trim().slice(0, 140);
          let content;
          const doc = CLEAN(quote);
          if (m === 'fenced_json') content = '```json\n' + JSON.stringify(doc) + '\n```';
          else if (m === 'think_tags') content = '<think>secret reasoning</think>' + JSON.stringify(doc);
          else if (m === 'non_json') content = 'I am sorry, I cannot produce JSON today.';
          else if (m === 'xss') { doc.flagged_clauses[0].why_its_risky = '<script>alert("xss")</script><img src=x onerror=alert(1)>'; content = JSON.stringify(doc); }
          else if (parsed.messages?.[0]?.content?.includes('Answer the user')) content = 'Twin answer: see the clause above. Simulated, not legal advice.';
          else content = JSON.stringify(doc);
          const id = `chatcmpl-twin-${++twin.counter}`;
          const inner = Buffer.from(m === 'non_json_body' ? '<html>not json</html>' : JSON.stringify({
            id, created: Math.floor(Date.now() / 1000), model: parsed.model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }), 'utf8');
          const raw = m === 'bom_body' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), inner]) : inner; // enclave signs these exact bytes
          twin.store.set(id, { req: body, res: raw, model: parsed.model });
          res.writeHead(200, { 'Content-Type': m === 'non_json_body' ? 'text/html' : 'application/json' });
          return res.end(raw);
        }
        const sm = u.pathname.match(/^\/v1\/signature\/(.+)$/);
        if (req.method === 'GET' && sm) {
          const id = decodeURIComponent(sm[1]);
          const rec = twin.store.get(id);
          const m = s.signature || 'ok';
          if (m === '401') return json(401, { error: { message: 'twin: unauthorized' } });
          const hits = (twin.sigHits.get(id) || 0) + 1; twin.sigHits.set(id, hits);
          if (!rec || (m === '404_then_ok' && hits <= 2)) return json(404, { error: { message: 'twin: signature not ready' } });
          let reqH = sha256hex(rec.req), resH = sha256hex(rec.res), model = rec.model, w = wallet;
          if (m === 'tampered_res') resH = sha256hex(Buffer.concat([rec.res, Buffer.from(' ')]));
          if (m === 'tampered_req') reqH = sha256hex(Buffer.concat([rec.req, Buffer.from(' ')]));
          if (m === 'model_mismatch') model = 'other/model';
          if (m === 'wrong_signer') w = otherWallet;
          const text = m === 'no_model_prefix' ? `${reqH}:${resH}` : `${model}:${reqH}:${resH}`;
          return json(200, { text, signature: await w.signMessage(text), signing_address: w.address, signing_algo: 'ecdsa' });
        }
        if (req.method === 'GET' && u.pathname === '/v1/models') return json(200, { data: [{ id: fixture.model, owned_by: 'nearai', name: 'twin' }] });
        json(404, { error: { message: 'twin: no route' } });
      } catch (e) { json(500, { error: { message: String(e.message) } }); }
    });
  });
  twin.listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const o = `${tls ? 'https' : 'http'}://${tls ? 'localhost' : '127.0.0.1'}:${port}`;
    twin.url = `${o}/v1`; twin.nrasUrl = `${o}/nras`; twin.jwksUrl = `${o}/jwks`;
    resolve(twin);
  }));
  twin.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  twin.reset = () => { twin.script = {}; twin.chatRequests = 0; twin.requests = []; twin.store.clear(); twin.sigHits.clear(); };
  return twin;
}
