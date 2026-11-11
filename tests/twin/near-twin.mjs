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

const TAG = '[Simulated twin output] ';
const clause = (clause_title, risk_level, original_text, why_its_risky, suggested_redline) => ({ clause_title, risk_level, original_text, why_its_risky, suggested_redline });

// Sample-aware canned analyses (quotes are verbatim from samples/*.txt; tests assert quoteFound for each).
const SAMPLES = {
  'MUTUAL NON-DISCLOSURE AND EVALUATION AGREEMENT': {
    overall_risk: 'High',
    executive_summary: 'Despite its "mutual" title, this NDA protects only the Company: Recipient carries perpetual, uncapped obligations while Company owes nothing. Venue in the Cayman Islands makes any dispute costly to fight.',
    flagged_clauses: [
      clause('1. Confidential Information (one-sided definition)', 'High', 'Information disclosed by Recipient to Company shall NOT be deemed Confidential Information unless expressly agreed in an amendment signed by Company\'s CEO.', 'The agreement is titled mutual but only the Company\'s information is protected; anything Recipient shares can be used freely.', 'Confidential Information means any non-public information disclosed by either party to the other, whether orally or in writing, that is marked or reasonably understood to be confidential.'),
      clause('2. Perpetual Term', 'High', 'Recipient\'s obligations of confidentiality under this Agreement shall survive in perpetuity, including with respect to information that becomes publicly known through no fault of Recipient.', 'Obligations never expire and even bind Recipient over public information, so ordinary public knowledge could become a breach.', 'Each party\'s confidentiality obligations shall continue for three (3) years from disclosure, and shall not apply to information that becomes publicly known through no fault of the receiving party.'),
      clause('3. Feedback & IP Assignment', 'High', 'Any ideas, suggestions, feedback, or derivative concepts shared by Recipient during discussions shall automatically become the sole and exclusive property of Company', 'Everything Recipient says in discussions is assigned away for free, including its own ideas and derivative concepts.', 'Each party retains all rights in its own ideas and materials. Feedback may be used by the receiving party without obligation, but no ownership is transferred.'),
      clause('4. Uncapped Indemnification', 'High', 'Recipient shall indemnify, defend, and hold harmless Company against any and all claims, damages, losses, and attorney fees arising out of or relating to this Agreement, with no cap on liability.', 'Unlimited, one-way liability for any claim relating to the agreement is a bet-the-company exposure.', 'Each party\'s aggregate liability under this Agreement shall not exceed fees paid or USD 50,000, whichever is greater, and indemnity applies only to the indemnitor\'s breach of confidentiality.'),
      clause('5. Governing Law & Venue', 'Medium', 'any disputes shall be resolved exclusively in courts located in George Town, Cayman Islands.', 'An exclusive offshore forum makes enforcement and defense prohibitively expensive for Recipient.', 'This Agreement is governed by the laws of the State of Delaware, and disputes shall be heard in the state or federal courts located in Delaware.'),
    ],
    missing_protections: ['Mutual confidentiality obligations for both parties', 'Standard exclusions (public domain, independently developed, rightfully received from a third party, already known)', 'Return or destruction of confidential materials on request or termination'],
  },
  'STANDARD MUTUAL NON-DISCLOSURE AGREEMENT': {
    overall_risk: 'Low',
    executive_summary: 'A balanced, mutual NDA with reciprocal obligations and standard carve-outs. No clauses stand out as predatory.',
    flagged_clauses: [],
    missing_protections: ['Optional: an explicit timeline for deleting archival backup copies'],
  },
  'INDEPENDENT CONTRACTOR SERVICES AGREEMENT': {
    overall_risk: 'High',
    executive_summary: 'This contractor agreement shifts nearly all risk to the Contractor: open-ended scope, slow and discretionary payment, an IP grab and a worldwide non-compete, with asymmetric termination and liability. The auto-renewal notice window is also a trap.',
    flagged_clauses: [
      clause('1. Services (scope creep)', 'Medium', 'including any additional services Client deems reasonably related.', 'Scope is open-ended and decided unilaterally by the Client, with no change-order or extra pay.', 'Services are limited to those in a written statement of work; additional services require a signed change order and agreed fees.'),
      clause('2. Payment (net-90, discretionary withholding)', 'High', 'Client may withhold payment for any deliverable it determines, in its sole discretion, to be unsatisfactory.', 'Combined with net-90 terms, the Client can delay or refuse payment on a subjective call.', 'Client shall pay undisputed invoices within thirty (30) days; any dispute must be raised in writing within ten (10) days with specific, reasonable grounds.'),
      clause('3. Intellectual Property (beyond scope)', 'High', 'whether or not related to the Services and whether or not created using Client resources, shall be the exclusive property of Client.', 'Captures everything the Contractor creates during the term, including unrelated personal and other-client work.', 'Client owns only work product created specifically for the Services and paid for; Contractor retains pre-existing and unrelated IP.'),
      clause('4. Non-Competition', 'High', 'Contractor shall not provide software development services to any business anywhere in the world.', 'A five-year, worldwide ban on the Contractor\'s whole trade is overbroad and likely to be unenforceable, but costly to contest.', 'Delete the non-compete, or limit it to direct competitors of the Client for six (6) months within the specific project domain.'),
      clause('5. Termination (asymmetric)', 'High', 'Client may terminate this Agreement at any time without notice. Contractor may terminate this Agreement upon one hundred eighty (180) days\' written notice.', 'The Client can walk away instantly while the Contractor is locked in for six months.', 'Either party may terminate on thirty (30) days\' written notice; Client pays for work performed through the termination date.'),
      clause('6. Liability (unlimited vs $100)', 'High', 'Contractor\'s liability under this Agreement shall be unlimited. Client\'s total liability shall not exceed one hundred dollars ($100).', 'Unlimited exposure for the Contractor against a $100 ceiling for the Client.', 'Each party\'s total liability is capped at the fees paid or payable under this Agreement in the preceding twelve (12) months.'),
      clause('7. Automatic Renewal (notice trap)', 'Medium', 'unless Contractor provides notice of non-renewal no earlier than 190 days and no later than 180 days before the end of the then-current term.', 'The notice window is only ten days wide, so a missed date silently renews the one-sided terms.', 'Either party may give notice of non-renewal at any time at least thirty (30) days before the end of the term.'),
    ],
    missing_protections: ['Payment deadline and late-payment interest', 'Kill fee or payment for work done on termination', 'Mutual indemnity and an insurance requirement', 'Dispute-resolution and governing-law clause'],
  },
};

const GENERIC = (quote) => ({
  overall_risk: 'High',
  executive_summary: 'This simulated analysis shows the UI states for an unrecognized contract. It is not real model output.',
  flagged_clauses: [
    clause('Simulated clause', 'High', quote, 'Simulated: one-sided obligation with no mutuality.', 'Each party shall bear its obligations equally and for a reasonable, fixed term.'),
    clause('Hallucinated clause', 'Medium', 'This sentence is not in the contract.', 'Simulated: exercises the "not found verbatim" tag.', 'N/A'),
  ],
  missing_protections: ['Simulated: mutual termination right', 'Simulated: liability cap'],
});

export const twinAnalysis = (contract, quote) => {
  const title = String(contract).trimStart().split('\n')[0].trim();
  const doc = structuredClone(SAMPLES[title] || GENERIC(quote));
  doc.executive_summary = TAG + doc.executive_summary;
  return doc;
};

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
          const doc = twinAnalysis(contract, quote);
          if (m === 'fenced_json') content = '```json\n' + JSON.stringify(doc) + '\n```';
          else if (m === 'think_unclosed') content = (parsed.messages?.[0]?.content?.includes('Answer the user') ? 'Okay, {the user} asks about the term. Let me check {section 2}.\n</think>\n\n' + JSON.stringify({ answer: 'Twin answer: see the clause above. Simulated, not legal advice.' }) : 'Okay, the user wants JSON like {"overall_risk": ...}. Let me look at {clause 1} and {clause 2} carefully; maybe {"x": 1}.\n</think>\n\n' + JSON.stringify(doc));
          else if (m === 'think_tags') content = '<think>secret reasoning</think>' + JSON.stringify(doc);
          else if (m === 'non_json') content = 'I am sorry, I cannot produce JSON today.';
          else if (m === 'xss') { doc.flagged_clauses[0].why_its_risky = '<script>alert("xss")</script><img src=x onerror=alert(1)>'; content = JSON.stringify(doc); }
          else if (parsed.messages?.[0]?.content?.includes('Answer the user')) { const a = 'Twin answer: see the clause above. Simulated, not legal advice.'; content = parsed.response_format ? JSON.stringify({ answer: a }) : a; }
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
