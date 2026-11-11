// NEAR AI Cloud client (OpenAI-compatible) + private contract analysis.
// ZERO RETENTION: contract text, prompts and model output live only in local
// variables for the lifetime of one call. Nothing is logged, cached or written.

import fs from 'node:fs';
import path from 'node:path';
import { NEAR_BASE, attestModel, verifyResponseSignature } from './attest.mjs';

// --- config (.env is read once at startup; only the API key is kept) -------------
function loadEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

export const API_KEY = process.env.NEAR_API_KEY || process.env.NEARAI_API_KEY || '';
// Confidential TEE models are the ones with owned_by === "nearai" in GET /v1/models.
export const MODEL = process.env.NEAR_MODEL || 'z-ai/glm-5.3-flash';

export async function listTeeModels() {
  const res = await fetch(`${NEAR_BASE}/models`, { signal: AbortSignal.timeout(15000) });
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

function extractJson(text) {
  const cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

class NearError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** One private chat completion. Returns parsed body plus the EXACT bytes for signature checks. */
async function chat(messages, { maxTokens = 4000, json = false } = {}) {
  if (!API_KEY) throw new NearError('NEAR_API_KEY is not set in .env', 500);
  const payload = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false },
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  const requestBody = JSON.stringify(payload); // exact bytes we hash for the signature check
  const res = await fetch(`${NEAR_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: requestBody,
    signal: AbortSignal.timeout(180000),
  });
  const responseBody = await res.text(); // exact bytes signed by the enclave
  if (!res.ok) {
    let msg = responseBody.slice(0, 300);
    try { msg = JSON.parse(responseBody).error?.message || msg; } catch {}
    throw new NearError(`NEAR AI Cloud ${res.status}: ${msg}`, res.status === 401 ? 401 : 502);
  }
  const body = JSON.parse(responseBody);
  return { body, requestBody, responseBody, content: body.choices?.[0]?.message?.content || '' };
}

async function signatureWithRetry(args) {
  // The signature is published right after completion; retry briefly if not yet available.
  let last;
  for (let i = 0; i < 3; i++) {
    last = await verifyResponseSignature(args);
    if (!last.checks.some((c) => c.id === 'sig_fetch')) return last;
    await new Promise((r) => setTimeout(r, 800));
  }
  return last;
}

/**
 * Full private pipeline: attest (fresh nonce) -> infer in TEE -> verify response signature.
 */
export async function analyzeContract(contractText) {
  const t0 = Date.now();
  // 1) Pre-flight: prove the enclave is genuine BEFORE sending it the contract.
  const attestation = await attestModel(MODEL, API_KEY);
  if (!attestation.verified) {
    const err = new NearError('TEE attestation failed — contract was NOT sent to the model.', 502);
    err.attestation = attestation;
    throw err;
  }
  // 2) Private inference inside the attested TEE.
  const r = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `CONTRACT TEXT:\n\n${contractText}` },
  ], { json: true });
  let analysis;
  try { analysis = extractJson(r.content); } catch {
    analysis = { overall_risk: 'Unknown', executive_summary: r.content.slice(0, 600), flagged_clauses: [], missing_protections: [] };
  }
  // 3) Prove THIS response came from THAT enclave.
  const signature = await signatureWithRetry({
    chatId: r.body.id, model: MODEL, requestBody: r.requestBody, responseBody: r.responseBody,
    apiKey: API_KEY, attestedSigner: attestation.signingAddress,
  });
  return {
    analysis,
    attestation,
    signature: { ...signature, chatId: r.body.id },
    usage: r.body.usage,
    model: MODEL,
    retention: { bytesWrittenToDisk: 0, logged: false, storedContracts: 0 },
    ms: Date.now() - t0,
  };
}

export async function askFollowUp(contractText, question) {
  const attestation = await attestModel(MODEL, API_KEY);
  if (!attestation.verified) throw new NearError('TEE attestation failed — question was NOT sent.', 502);
  const r = await chat([
    { role: 'system', content: FOLLOWUP_PROMPT },
    { role: 'user', content: `CONTRACT:\n${contractText}\n\nQUESTION: ${question}` },
  ], { maxTokens: 600 });
  const signature = await signatureWithRetry({
    chatId: r.body.id, model: MODEL, requestBody: r.requestBody, responseBody: r.responseBody,
    apiKey: API_KEY, attestedSigner: attestation.signingAddress,
  });
  return { answer: r.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), attestation, signature: { ...signature, chatId: r.body.id } };
}
