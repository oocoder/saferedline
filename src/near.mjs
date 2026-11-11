// NEAR AI Cloud client (OpenAI-compatible) + private contract analysis.
// ZERO RETENTION: contract text, prompts and model output live only in local
// variables for the lifetime of one call. Nothing is logged, cached or written.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deps, attestModel, verifyResponseSignature } from './attest.mjs';
import { AppError } from './errors.mjs';

// --- config (.env is read once at startup from the repo root; only the API key is kept) ----
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

// Injectable config (tests / twin). Confidential TEE models are owned_by === "nearai" in GET /v1/models.
export const cfg = {
  apiKey: process.env.NEAR_API_KEY || process.env.NEARAI_API_KEY || '',
  model: process.env.NEAR_MODEL || 'z-ai/glm-5.3-flash',
  attest: attestModel,
  timeoutMs: Number(process.env.NEAR_TIMEOUT_MS) || 90000,
  sigRetry: { tries: 5, delays: [300, 600, 1200, 2000] },
  // Serialize the request as pure-ASCII JSON (\uXXXX escapes). Valid JSON either way; guards against the
  // gateway re-serializing non-ASCII before hashing. Live result recorded in docs: see ASCII_SAFE_JSON.
  asciiSafe: process.env.ASCII_SAFE_JSON !== '0',
};
export function setNearDeps(o) { Object.assign(cfg, o); }
// Convenience snapshots for scripts (use cfg for the live values).
export const API_KEY = cfg.apiKey;
export const MODEL = cfg.model;

export async function listTeeModels() {
  const res = await deps.fetch(`${deps.baseUrl}/models`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new AppError(`Model list unavailable (HTTP ${res.status})`, { status: 502, code: 'INFERENCE_FAILED', stage: 'inference' });
  const { data = [] } = await res.json();
  return data
    .filter((m) => m.owned_by === 'nearai' && (m.output_modalities || ['text']).includes('text') && !/embedding|reranker|whisper|flux|privacy-filter/i.test(m.id))
    .map((m) => ({ id: m.id, name: m.name, context: m.context_length }));
}

export const SYSTEM_PROMPT = `You are SafeRedline, a meticulous corporate and commercial contracts analyst running inside a hardware-isolated Trusted Execution Environment (TEE).

Analyze the user's contract text and identify predatory, one-sided, or risky clauses, as well as missing standard protections. Return ONLY valid JSON matching this exact schema:

{
  "overall_risk": "High | Medium | Low",
  "executive_summary": "2-sentence plain-English summary of the contract and its biggest risks.",
  "flagged_clauses": [
    {
      "clause_title": "Section name or topic",
      "risk_level": "High | Medium",
      "original_text": "Exact verbatim quote from the contract",
      "why_its_risky": "Clear explanation of the business or legal trap",
      "suggested_redline": "Balanced, copy-pasteable replacement wording"
    }
  ],
  "missing_protections": [
    "Short bullet describing a standard protection missing from this agreement"
  ]
}

Rules: quote original_text verbatim. If the contract is balanced, return an empty flagged_clauses array and overall_risk "Low". Output JSON only — no markdown fences, no commentary. This is informational analysis, not legal advice.`;

const FOLLOWUP_PROMPT = `You are SafeRedline, a contracts analyst running inside a hardware-isolated TEE. Answer the user's question about the contract below concisely (max ~150 words), in plain English, citing the relevant section number. This is informational, not legal advice.`;


const FOLLOWUP_PROMPT_TEXT = FOLLOWUP_PROMPT;

function extractJson(text) {
  const cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no json');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const RISKS = ['High', 'Medium', 'Low', 'Unknown'];
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Coerce model output into the Analysis contract; quoteFound is a hallucination guard. */
export function normalizeAnalysis(a, contractText) {
  const hay = norm(contractText);
  const clauses = Array.isArray(a?.flagged_clauses) ? a.flagged_clauses : [];
  return {
    overall_risk: RISKS.includes(a?.overall_risk) ? a.overall_risk : 'Unknown',
    executive_summary: str(a?.executive_summary),
    flagged_clauses: clauses.filter((c) => c && typeof c === 'object').map((c) => ({
      clause_title: str(c.clause_title),
      risk_level: c.risk_level === 'High' ? 'High' : 'Medium',
      original_text: str(c.original_text),
      why_its_risky: str(c.why_its_risky),
      suggested_redline: str(c.suggested_redline),
      quoteFound: norm(c.original_text).length > 0 && hay.includes(norm(c.original_text)),
    })),
    missing_protections: (Array.isArray(a?.missing_protections) ? a.missing_protections : []).map(str),
  };
}

const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

async function post(requestBody) {
  let res;
  try {
    res = await deps.fetch(`${deps.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: requestBody,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    return { res, raw: Buffer.from(await res.arrayBuffer()) }; // exact bytes the enclave signs
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new AppError(`The model did not answer within ${Math.round(cfg.timeoutMs / 1000)}s`, { status: 504, code: 'INFERENCE_TIMEOUT', stage: 'inference', contractSent: true });
    }
    throw new AppError('Could not reach NEAR AI Cloud for inference', { status: 502, code: 'INFERENCE_FAILED', stage: 'inference', contractSent: true });
  }
}

/** One private chat completion. Returns the EXACT request/response bytes for signature checks. */
async function chat(messages, { maxTokens = 4000, json = false } = {}) {
  const build = (useJson) => {
    const payload = {
      model: cfg.model, messages, max_tokens: maxTokens, temperature: 0.2,
      chat_template_kwargs: { enable_thinking: false },
      ...(useJson ? { response_format: { type: 'json_object' } } : {}),
    };
    return cfg.asciiSafe ? asciiJson(payload) : JSON.stringify(payload);
  };
  let jsonMode = json ? 'native' : 'prompt-only';
  let requestBody = build(json);
  let { res, raw } = await post(requestBody);
  if (res.status === 400 && json) {
    let msg = '';
    try { msg = JSON.parse(raw.toString('utf8')).error?.message || ''; } catch { /* ignore */ }
    if (/response_format|json/i.test(msg)) {
      jsonMode = 'prompt-only';
      requestBody = build(false); // a NEW request -> new bytes -> new signature, which we verify as usual
      ({ res, raw } = await post(requestBody));
    }
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new AppError(`NEAR AI Cloud rejected the API key (HTTP ${res.status})`, { status: 502, code: 'NEAR_AUTH', stage: 'inference', contractSent: true });
    throw new AppError(`NEAR AI Cloud returned HTTP ${res.status}`, { status: 502, code: 'INFERENCE_FAILED', stage: 'inference', contractSent: true });
  }
  let body;
  // Parse leniently (strip a BOM) but keep hashing the untouched raw bytes.
  try { body = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch { body = null; }
  if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !body.id) {
    throw new AppError('NEAR returned a non-JSON or malformed response', { status: 502, code: 'INFERENCE_FAILED', stage: 'inference', contractSent: true });
  }
  const c = body.choices?.[0]?.message?.content;
  return { body, requestBody, raw, jsonMode, content: typeof c === 'string' ? c : '' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function signatureWithRetry(args) {
  // The signature is published shortly after completion; retry only on 404 / network errors (never on 401).
  const { tries, delays } = cfg.sigRetry;
  let last;
  for (let i = 0; i < tries; i++) {
    last = await verifyResponseSignature(args);
    if (!last.checks.some((c) => c.id === 'sig_fetch')) return last;
    if (last.fetchStatus !== 404 && last.fetchStatus !== 0) return last;
    if (i < tries - 1) await sleep(delays[Math.min(i, delays.length - 1)]);
  }
  return last;
}

function requireKey() {
  if (!cfg.apiKey) throw new AppError('NEAR_API_KEY is not set (put it in .env)', { status: 503, code: 'NO_API_KEY', stage: 'config' });
}

/** GATE: attest first; if it does not verify, throw BEFORE any contract bytes are sent. */
async function attestOrThrow() {
  const attestation = await cfg.attest(cfg.model, cfg.apiKey);
  if (!attestation.verified) {
    if (attestation.unavailable?.length) {
      throw new AppError(`Could not complete attestation: ${attestation.unavailable.join(', ')} unreachable — failing closed. Contract was NOT sent.`, { status: 503, code: 'ATTESTATION_UNAVAILABLE', stage: 'attestation', attestation });
    }
    throw new AppError('TEE attestation failed — contract was NOT sent to the model.', { status: 502, code: 'ATTESTATION_FAILED', stage: 'attestation', attestation });
  }
  return attestation;
}

const sigArgs = (r, attestation) => ({
  chatId: r.body.id, model: cfg.model, requestBody: Buffer.from(r.requestBody, 'utf8'), responseBody: r.raw,
  apiKey: cfg.apiKey, attestedSigners: attestation.signingAddresses,
});

/** Full private pipeline: attest (fresh nonce) -> infer in TEE -> verify response signature. */
export async function analyzeContract(contractText) {
  const t0 = Date.now();
  requireKey();
  const attestation = await attestOrThrow();
  const r = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `CONTRACT TEXT:\n\n${contractText}` },
  ], { json: true });
  let parsed, analysisParseError = false;
  try { parsed = extractJson(r.content); } catch {
    analysisParseError = true;
    parsed = { overall_risk: 'Unknown', executive_summary: r.content.replace(/<think>[\s\S]*?<\/think>/g, '').slice(0, 600) };
  }
  const analysis = normalizeAnalysis(parsed, contractText);
  const signature = await signatureWithRetry(sigArgs(r, attestation));
  return {
    verified: attestation.verified && signature.verified,
    analysis, analysisParseError, jsonMode: r.jsonMode,
    attestation, signature,
    usage: r.body.usage ?? null,
    model: cfg.model,
    retention: { bytesWrittenToDisk: 0, logged: false, storedContracts: 0 },
    ms: Date.now() - t0,
  };
}

export async function askFollowUp(contractText, question) {
  const t0 = Date.now();
  requireKey();
  const attestation = await attestOrThrow();
  const r = await chat([
    { role: 'system', content: FOLLOWUP_PROMPT_TEXT },
    { role: 'user', content: `CONTRACT:\n${contractText}\n\nQUESTION: ${question}` },
  ], { maxTokens: 600 });
  const signature = await signatureWithRetry(sigArgs(r, attestation));
  return {
    verified: attestation.verified && signature.verified,
    answer: r.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
    attestation, signature, model: cfg.model, ms: Date.now() - t0,
  };
}
