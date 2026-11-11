# HTTP API

Contract copied from plan section 4 ([plan](plans/2026-11-11-architecture-plan.md)). Server: `http://127.0.0.1:3000` (override with `HOST`, `PORT`).


**Shared types:**

```ts
Check = { id: string, label: string, pass: boolean, detail?: string,
          scope: 'gateway' | 'model' | 'gpu' | 'signature' | 'info' }

Attestation = {
  verified: boolean, nonce: string /*64 hex*/, model: string,
  signingAddresses: string[], gatewaySigningAddress: string | null,
  appName: string | null, composeHash: string | null,
  tcbStatus: string | null,                       // 'UpToDate' → green, else amber
  measurement: { mrtd: string, rtmr3: string, mrConfigId: string } | null,
  hardware: string, gpuCount: number | null,
  checks: Check[], verifiedAt: string /*ISO*/, ms: number
}

Signature = {
  verified: boolean, chatId: string, signingAddress: string | null, signingAlgo: string | null,
  text: string | null, requestSha256: string, responseSha256: string, checks: Check[]
}

Clause = { clause_title: string, risk_level: 'High' | 'Medium', original_text: string,
           why_its_risky: string, suggested_redline: string, quoteFound: boolean }

Analysis = { overall_risk: 'High' | 'Medium' | 'Low' | 'Unknown', executive_summary: string,
             flagged_clauses: Clause[], missing_protections: string[] }
```

`Check.scope` lets B group the panel; A sets it instead of the `"Model TEE:"` label prefix.

**Error envelope (every non-2xx):**

```ts
{ error: { code: ErrorCode, message: string /* human, safe, never contains contract text */,
           stage: 'input' | 'config' | 'attestation' | 'inference' | 'signature' | 'server',
           contractSent: boolean },
  attestation?: Attestation }   // present for ATTESTATION_FAILED
```

| ErrorCode | HTTP | contractSent |
|---|---|---|
| `BAD_INPUT` | 400 | false |
| `TOO_LARGE` | 413 | false |
| `NO_API_KEY` | 503 | false |
| `ATTESTATION_FAILED` | 502 | false |
| `ATTESTATION_UNAVAILABLE` (NEAR, PCCS or NRAS unreachable; message names which) | 503 | false |
| `NEAR_AUTH` | 502 | true |
| `INFERENCE_FAILED` | 502 | true |
| `INFERENCE_TIMEOUT` | 504 | true |
| `NOT_FOUND` | 404 | false |
| `INTERNAL` | 500 | unknown, reported as false only if before the send |

A signature failure is **not** an error. It returns 200 with `verified: false`.

**Endpoints:**

- **`GET /api/health`** → `{ ok: true, model: string, apiKeyConfigured: boolean, mode: 'live' | 'twin', persistence: 'none', bind: string, version: string }`
- **`GET /api/samples`** → `[{ id: 'sample_predatory_nda', title: 'Predatory SaaS NDA', riskHint: 'High', text: string }, ...]`. Ordered predatory, balanced, contractor.
- **`GET /api/attest`** → `200 Attestation`. Returned even when `verified` is false; the UI shows the red checks. Needs no key. `503 ATTESTATION_UNAVAILABLE` only when the report itself can't be fetched.
- **`POST /api/analyze`**
  - Request: `{ text: string /* 50..512KB chars, trimmed */, source?: 'paste' | 'txt' | 'pdf' | 'sample' }`. `source` is optional metadata; it is never logged.
  - 200: `{ verified: boolean /* attestation.verified && signature.verified */, analysis: Analysis, analysisParseError: boolean, jsonMode: 'native' | 'prompt-only', attestation: Attestation, signature: Signature, usage: object | null, model: string, retention: { bytesWrittenToDisk: 0, logged: false, storedContracts: 0 }, ms: number }`
- **`POST /api/ask`**
  - Request: `{ text: string /* 50..512KB */, question: string /* 1..1000 */ }`
  - 200: `{ verified: boolean, answer: string, attestation: Attestation, signature: Signature, model: string, ms: number }`


Related: [architecture.md](architecture.md).
