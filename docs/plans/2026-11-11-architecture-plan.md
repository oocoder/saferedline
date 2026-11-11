Approved 2026-11-11 13:05 ET. Engineers: A=backend/tests/twin, B=UI, C=docs. Also C adds AGENTS.md (ICM-style entry map, <=60 lines) + CLAUDE.md (one-line pointer to AGENTS.md).

# SafeRedline architecture plan (1:00 PM, freeze at 4:30)

The current code doesn't have a giant hole, but it has several fail-open paths. They're small fixes. The biggest issue the README must be honest about is that **nothing binds the TLS channel to the enclave.**

---

## 1. Trust boundary and threat model

**Trust chain:** Browser (localhost) → **SafeRedline server (our code, not in a TEE, sees plaintext)** → TLS to cloud-api.near.ai → **NEAR gateway in a TEE (attested, sees plaintext)** → **model in a TEE with GPU CC (attested, sees plaintext)**.

- **Proven, before any contract leaves our server:**
  - The model and gateway enclaves are genuine Intel TDX with TCB accepted and debug off.
  - The quote binds a fresh 32-byte nonce, so the evidence is live and not replayed.
  - The quote binds the enclave's signing key.
  - The app's docker-compose hash is in MRCONFIGID and the RTMR3 runtime log replays.
  - NVIDIA NRAS says the GPUs are in confidential-computing mode, against the same nonce.
- **Proven, after the response comes back:** the exact request bytes we sent and the exact response bytes we got were signed (EIP-191) by a key that was attested in step 1. So the output really came from that enclave and wasn't modified on the way.
- **Not proven: transport binding.** We call the report with `include_tls_fingerprint=false` (src/attest.mjs:51). We never prove that the TLS endpoint we sent the plaintext to *is* the attested gateway. Any NEAR front proxy or load balancer before the TEE is trusted only through ordinary WebPKI TLS. The signature check gives integrity after the fact, not confidentiality.
- **Not proven: what the code inside does.** We show the compose hash but don't pin it to a known-good NEAR release, and we don't check that the image digests serve the claimed weights. "No retention inside NEAR" rests on the attested compose being what NEAR publishes, and we don't audit that.
- **Not proven: our own server.** We don't run in a TEE, so "zero retention" on our side is a code-level claim. You can check it by reading the code (no fs writes, no DB, metadata-only logs), but it isn't attested. OS swap and core dumps are out of scope.
- **Who it's for:** a founder or small legal team who runs SafeRedline on their own machine (bound to 127.0.0.1). The only outside party that sees the plaintext is NEAR's attested gateway and model enclaves.
- **README claim (use this wording):** *"SafeRedline runs on your machine and sends your contract only to a NEAR AI Cloud model after cryptographically verifying, with a fresh nonce, that the model and gateway run in genuine Intel TDX + NVIDIA confidential-computing enclaves. Every answer is checked against an enclave-held key bound to that attestation. SafeRedline itself stores nothing. Limits: the TLS connection is not pinned to the enclave, and the enclave's software is identified by hash, not audited."*

---

## 2. Defects and fail-open risks

Fail-open means a check is skipped and `verified` still comes out `true`. P0 means fix before the demo.

| # | Location | Problem | Fix | Pri |
|---|---|---|---|---|
| 1 | src/attest.mjs:111 | If `td.reportData` is missing, the debug, signer, nonce, compose and RTMR3 checks are all **skipped**. `verified` can still be true. **Fail-open.** | Add `else checks.push(check('td_parse', ..., false, 'quote body not TD10'))`. | P0 |
| 2 | src/attest.mjs:121 | The compose check only runs `if (compose != null)`. A missing `app_compose` means no check. **Fail-open.** | Always push the check, and fail it when compose is absent. Also check the RTMR3 event `compose-hash` payload equals `h`. Optionally fail if env `EXPECTED_COMPOSE_HASH` is set and differs. | P0 |
| 3 | src/attest.mjs:161, 174 | `.find(!m.model_name \|\| ...)` falls back to `[0]`, so only **one** model instance is verified and only its signer is kept. The gateway can send the completion to a different instance with a different key, which gives a false "wrong signer" failure. | Verify **every** entry in `model_attestations` and return `signingAddresses: [...]`. All must pass. `sig_attested` passes if the recovered address is in that set. | P0 |
| 4 | src/attest.mjs:168 | A missing `gateway_attestation` means zero gateway checks. The gateway sees plaintext. **Fail-open.** | Push `check('gateway_present', ..., false)` when it's absent. | P0 |
| 5 | src/attest.mjs:205 | `if (attestedSigner)` means an undefined signer skips `sig_attested`. **Fail-open.** | Always push the check, and fail it when there is no attested signer set. | P0 |
| 6 | src/attest.mjs:196-197 | `split(':')` breaks if a model id contains `:`. The model prefix is never compared with what we requested. | `const p = text.split(':'); resH = p.pop(); reqH = p.pop(); signedModel = p.join(':')`. If `signedModel` is non-empty, require it to equal `model` (check `sig_model`). Require `signing_algo/signature_kind === 'ecdsa'`. **Confirm the field name live**: the code reads `signature_kind`, while the reference verifier returns `signing_algo`. | P0 |
| 7 | src/attest.mjs:103 and dcap-qvl collateral.js:75,103,228,239,257 | `getCollateralAndVerify` uses bare `fetch` with **no timeout**, so a PCCS outage can hang the request forever. The error text is just "fetch failed". It fails closed, but the error is unclear and it's untestable. | Inject the seam (§3): `collateral = await withTimeout(deps.getCollateral(pccsUrl, quote), 15000, 'Intel PCCS (collateral) unreachable — failing closed')`, then `verify(quote, collateral, deps.nowSec())`. Use `PCCS_URL` from env, defaulting to `PHALA_PCCS_URL`, with fallback to `INTEL_PCS_URL` on network error. | P0 |
| 8 | src/attest.mjs:82-85 | `body[0][1]` throws a TypeError on an unexpected NRAS shape. The **JWT signature is never verified**: claims are base64-decoded only, so we trust NRAS over TLS. | Guard the shape: `throw new Error('NVIDIA NRAS returned unexpected response — failing closed')`. Map fetch or timeout errors to "NVIDIA NRAS unreachable — failing closed". JWT check against NRAS JWKS (ES384, `node:crypto`) is P2; otherwise state "NRAS verdict trusted via TLS" in the README. | P0 guard, P2 JWKS |
| 9 | src/near.mjs:87, scripts/verify_tee.mjs:24 | `res.text()` decodes with TextDecoder, which **strips a BOM** and replaces invalid UTF-8. The re-encoded bytes then differ from the bytes the enclave signed. | `const raw = Buffer.from(await res.arrayBuffer()); responseBody = raw.toString('utf8');` and hash `raw`. Pass the raw bytes to `verifyResponseSignature`, which should take `Buffer \| string`. | P0 |
| 10 | src/near.mjs:80 | **Non-ASCII risk.** Pasted contracts contain curly quotes, em dashes and section signs. If NEAR re-serializes the request before hashing, `sig_req` fails only on non-ASCII input. | Live test with a non-ASCII sample (`samples/sample_contractor_agreement.txt`: add “smart quotes” — § é). If it fails, serialize as pure ASCII: `JSON.stringify(p).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))`. Keep a flag `ASCII_SAFE_JSON`, default on. Both forms are valid JSON, so this is harmless. | P0 test |
| 11 | src/near.mjs:78, 91 | If the model rejects `response_format: json_object` with a 400, the whole analysis fails. | On a 400 whose message matches `/response_format\|json/i`, retry once without it. That builds a new `requestBody` and gets a new signature, which is fine. Record `jsonMode: 'native' \| 'prompt-only'`. | P0 |
| 12 | src/near.mjs:93-94 | `JSON.parse(responseBody)` on a non-JSON 200 throws a SyntaxError and returns 500. Node's message **includes a snippet of the model output**, which can quote the contract, in the error sent to the client (it isn't logged). A missing `body.id` leads to `/signature/undefined`. | Wrap it and throw `NearError('NEAR returned non-JSON response', 502, 'INFERENCE_FAILED')`. Never pass the parser message through. Require `body.id`. | P0 |
| 13 | src/near.mjs:81-86 | A network failure gives `TypeError: fetch failed` and 500. The timeout gives an AbortError and 500. 180 s is too long for a demo. | Map `TimeoutError` to 504 `INFERENCE_TIMEOUT` and other errors to 502 `INFERENCE_FAILED`. Timeout via `NEAR_TIMEOUT_MS`, default 90000. | P0 |
| 14 | src/near.mjs:126-128 | Model output that isn't JSON gets dressed up as an analysis with `overall_risk: 'Unknown'`. | Keep the fallback but set `analysisParseError: true`. Normalize the shape (arrays default to `[]`, risk restricted to High/Medium/Low/Unknown). Add `quoteFound` per clause: whitespace-normalized `includes()` against the contract text, as a hallucination guard. | P1 |
| 15 | src/near.mjs:130-142 | A failed signature still returns a normal-looking result, with no top-level verdict. | Return `verified = attestation.verified && signature.verified` and add `signature.verified = checks.every(pass)`. The UI renders a red "UNVERIFIED RESPONSE" state (contract in §4). | P0 |
| 16 | src/near.mjs:100-104 | Three tries 800 ms apart; it also retries on a 401. | Try 5 times with backoff 300/600/1200/2000 ms. Retry only on 404 or network errors, not on 401. | P1 |
| 17 | src/near.mjs:11 | `.env` is read from `process.cwd()`, so it's missing when started from another directory. | Resolve from the repo root (`import.meta.url`). | P1 |
| 18 | src/near.mjs:25 | `listTeeModels` has no `res.ok` check. | Add the check. | P1 |
| 19 | src/server.mjs:90 | `listen(PORT)` binds every interface, which contradicts the local/self-host privacy story. | `listen(PORT, process.env.HOST \|\| '127.0.0.1')`. | P0 |
| 20 | src/server.mjs:22 | Crashes at boot if `public/index.html` is missing (B creates it). The server module also auto-listens on import, so it can't be tested. | Export `createServer(deps)` and only listen when run as main. Read INDEX lazily. | P0 |
| 21 | src/server.mjs:28 | No CSP. | Add `Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; worker-src blob: https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'`. `connect-src 'self'` is a good demo line: the page physically cannot send the contract anywhere except our localhost server. | P0 |
| 22 | src/server.mjs:83 | The error shape is just a string, and every non-NearError becomes a 500. | Use the error envelope in §4. | P0 |
| 23 | src/attest.mjs:27 | `OutOfDate` is accepted. That's defensible (matches NEAR's reference verifier) but invisible. | Surface `tcbStatus` in the response. UI shows amber when it isn't `UpToDate`. | P1 |
| 24 | Ordering (src/near.mjs:114 → 121 → 130) | **Correct.** Attestation is fetched before the completion, and the response is tied to it by signer address. | Keep it. Add a check `sig_after_attest` that compares the time attestation was verified with the completion's `created`, as a sanity guard. | P2 |
| 25 | Stretch: TLS binding | See §1. | Get the report with `include_tls_fingerprint=true`, get the leaf certificate's SPKI sha256 via `tls.connect('cloud-api.near.ai:443')`, and compare. Show it as an **informational** check (`tls_bound`, not counted in `verified`), because a CDN in front will make it mismatch. | P2 |

---

## 3. Digital twin for offline tests (`node --test`, no new dependencies)

### Seams to add (A owns)

**src/attest.mjs** gets a module-level injectable `deps` object:

```js
export const deps = {
  fetch: (...a) => globalThis.fetch(...a),
  baseUrl: process.env.NEAR_BASE_URL || 'https://cloud-api.near.ai/v1',
  nrasUrl: process.env.NRAS_URL || 'https://nras.attestation.nvidia.com/v3/attest/gpu',
  pccsUrl: process.env.PCCS_URL || PHALA_PCCS_URL,
  getCollateral,                                 // from @phala/dcap-qvl (dcap-qvl `verify` is sync and offline)
  nowSec: () => Math.floor(Date.now() / 1000),   // passed to verify(quote, collateral, nowSec())
  newNonce: () => crypto.randomBytes(32).toString('hex'),
  timeouts: { attest: 30000, pccs: 15000, nras: 30000, signature: 15000 },
};
export function setDeps(o) { Object.assign(deps, o); }
```

- Every `fetch` and URL goes through `deps`.
- Replace `getCollateralAndVerify` with `deps.getCollateral` followed by `verify(quoteBytes, collateral, deps.nowSec())`. The collateral is JSON-serializable, because dcap-qvl returns plain arrays and strings.

**src/near.mjs** gets `setNearDeps({ apiKey, model, attest: attestModel, timeoutMs, sigRetry: { tries, delays } })`. Every function reads from that config.

**src/server.mjs** exports `createServer()` and listens only when `import.meta.url === pathToFileURL(process.argv[1]).href`.

### Fixture recorder: `scripts/record_fixtures.mjs` (public data only, needs no API key)

1. Generate a nonce and fetch the report with the real `deps`.
2. For each quote (gateway and every model instance), call `getCollateral(pccsUrl, quote)`.
3. For each `nvidia_payload`, POST it to NRAS.
4. Write `tests/fixtures/attestation.json`:
   `{ recordedAt: <unixSec>, model, nonce, report: <raw JSON>, collateral: { "<sha256(quoteHex)>": {...} }, nras: { "<sha256(payloadJSON)>": <raw NRAS body> } }`
5. Run the full live `attestModel` on that same nonce, and refuse to write the file unless `verified` is true.

The fixture is about 100–300 KB. Commit it.

### Twin server: `tests/twin/near-twin.mjs` (node:http, port 0)

Routes:

- `GET /v1/attestation/report` → `fixture.report`. It ignores the requested nonce, which is realistic: the nonce test proves that matters.
- `POST /nras` → looks up `fixture.nras[sha256(body)]`.
- `POST /v1/chat/completions` → returns `{ id: 'chatcmpl-twin-N', created, model, choices: [{ message: { content } }], usage }`. It stores the exact raw request bytes and raw response bytes under that id.
- `GET /v1/signature/:id?model=&signing_algo=ecdsa` → returns `text = `${model}:${sha256(req)}:${sha256(res)}``, `signature = await wallet.signMessage(text)`, and `{ text, signature, signing_address: wallet.address, signing_algo: 'ecdsa' }`.

`wallet` is a `new ethers.Wallet(<fixed test private key>)`.

The script is set per test as `twin.script = { attestation, nras, chat, signature }` with these modes:

- **chat:** `ok`, `fenced_json` (\`\`\`json…), `non_json`, `think_tags`, `400_response_format` (once, then ok), `401`, `500`, `hang` (never responds), `non_json_body` (HTTP 200 with an HTML body)
- **signature:** `ok`, `wrong_signer` (a second Wallet), `tampered_res` (signs the hash of different response bytes), `tampered_req`, `model_mismatch`, `404_then_ok` (2× 404), `401`
- **attestation / nras:** `fixture`, `503`, `hang`, `nras_bad_shape`

**Collateral injection:** `setDeps({ getCollateral: async (_, q) => fixture.collateral[sha256hex(q)], nowSec: () => fixture.recordedAt, newNonce: () => fixture.nonce })`. To simulate PCCS down: `getCollateral: () => Promise.reject(new Error('ECONNREFUSED'))`, or a function that never resolves with `timeouts.pccs = 200`.

**Pipeline happy path:** the recorded real attestation binds NEAR's key, and we don't have NEAR's private key. So pipeline tests inject `attest: async () => ({ ...realFixtureResult, signingAddresses: [wallet.address] })`. This is the "attestation fn" seam. The pairing of the real fixture with a twin signature is itself the natural **wrong-signer** test.

### Test files

**`tests/attest.offline.test.mjs`** (real fixture, fully offline):
- Recorded fixture: all 16 checks pass, `verified === true`.
- Injected nonce ≠ recorded nonce: `rd_nonce` and `nonce_echo` fail.
- Mutate `app_compose`: `compose` fails.
- Flip one byte of the quote body: `tdx_quote` fails.
- Drop one event from `event_log`: `rtmr3` fails.
- Delete `app_compose`: still FAILS (regression for #2).
- Delete `gateway_attestation`: fails (#4).
- `nowSec` = recordedAt + 400 days: `tdx_quote` fails (collateral expired).
- PCCS reject or hang: fails with "PCCS … failing closed" in under 1 s.
- NRAS 503 or bad shape: `gpu` fails with a clear message.

**`tests/signature.test.mjs`**:
- Signature cases: `ok`, `wrong_signer`, `tampered_res`, `tampered_req`, `model_mismatch`, an undefined attested signer (#5), and a model id containing `:` (#6).
- Non-ASCII contract: the request bytes are hashed exactly (#10).
- A BOM in the response body (#9).

**`tests/pipeline.test.mjs`** (twin + `createServer` on port 0, real HTTP):
- `/api/analyze`, ok: 200, `verified: true`, normalized analysis.
- `non_json`: 200 with `analysisParseError: true`.
- `400_response_format`: 200, `jsonMode: 'prompt-only'`.
- Chat `401`: 502 `NEAR_AUTH`.
- Chat `hang` (timeout 300 ms): 504 `INFERENCE_TIMEOUT`.
- Attestation fails: 502 `ATTESTATION_FAILED`, **and the twin's chat endpoint received zero requests** (contract never sent).
- PCCS down: 503 `ATTESTATION_UNAVAILABLE`, zero chat requests.
- `tampered_res`: 200, `verified: false`, `signature.verified: false`.
- `404_then_ok`: verified.
- Spy on `console.log` and `fs.writeFileSync`/`fs.promises.writeFile`, then assert the contract sentinel string `ZXQ-SECRET-7731` never appears in logs and no writes happen.
- Error responses never contain the sentinel string.

**Scripts:**
- `"test": "node --test tests/"`
- `"twin": "SAFEREDLINE_TWIN=1 node src/server.mjs"`. Twin mode starts the twin in-process. `/api/health` reports `mode: 'twin'` and the UI shows a permanent **"TWIN MODE: simulated enclave, not a real TEE"** banner. This doubles as the demo fallback if Wi-Fi or the key fails.

---

## 4. Work split and API contract

### File ownership (disjoint)

| Engineer | Owns | Must not touch |
|---|---|---|
| **A**: backend, tests, twin | `src/**`, `scripts/**`, `tests/**`, `samples/**`, `package.json`, `package-lock.json`, `.env.example`, `.gitignore` | `public/`, docs |
| **B**: UI | `public/index.html` (single file, inline CSS and JS) | everything else |
| **C**: docs | `README.md`, `LICENSE` (MIT), `OUTLINE.md`, `docs/**` (`architecture.md`, `threat-model.md`, `api.md`, `demo-script.md`, `submission-kit.md`) | code |

### Sequencing

- **By 1:30**, A pushes `createServer`, the new response shapes, and `npm run twin`, even if the twin only handles the happy path at first. B develops against `npm run twin` from then on. Before that, B hard-codes the example objects below.
- C writes `docs/api.md` from this section verbatim.
- Live key: whoever gets the `sk-` key runs `npm run verify` and the non-ASCII sample, then reports to A.

### API contract (all responses JSON, `Cache-Control: no-store`)

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

### UI requirements (B)

- **Left panel:**
  - Textarea and file input (.txt via `FileReader`; .pdf via pdf.js 3.11.174 from cdnjs: `pdf.min.js` plus `GlobalWorkerOptions.workerSrc` set to the cdnjs `pdf.worker.min.js`, with SRI).
  - Extract text page by page with `getTextContent` (`hasEOL` → `\n`). A PDF with no text shows "scanned PDF, paste text instead".
  - Sample buttons from `/api/samples`.
  - "Analyze privately" button with progress stages: Attesting enclave → Running in TEE → Verifying signature.
  - Risk badge, clause cards (quote, why it's risky, redline, Copy button, and a "not found verbatim" tag when `quoteFound` is false), missing-protections list.
  - "Ask a follow-up" box.
- **Right panel:**
  - Badge: green "Hardware TEE verified, zero data retention" only if `verified`. Red "UNVERIFIED" otherwise; red "Contract NOT sent" when `contractSent` is false.
  - Fields: nonce, model, signer, compose hash, MRTD, TCB status, GPU count, verified time, check list grouped by `scope`, signature hashes, retention line ("0 bytes written to disk"), and a "Verify enclave only" button that calls `/api/attest`.
  - TWIN banner when `health.mode === 'twin'`.
- **Behavior:** render every server string with `textContent`, never `innerHTML` (model output is untrusted). No localStorage of contract text. Usable at 375 px width.

---

## 5. Acceptance criteria

**A: backend, tests, twin**
1. `npm test` passes fully offline (no network) in under 30 s, with every listed test from §3. The P0 regressions #1–#6 and #9–#13 each have a test.
2. Live: `npm run verify -- --attest-only` passes 16+ checks. With the key, `npm run verify` passes, including `sig_req`, `sig_res`, `sig_ecdsa`, `sig_attested` and `sig_model`.
3. Live: analyzing a non-ASCII contract returns `signature.verified === true`. The ASCII-safe JSON choice is documented in a code comment with the observed result.
4. `node scripts/record_fixtures.mjs` regenerates `tests/fixtures/attestation.json` and refuses to write it unless live verification passed.
5. When attestation fails or is unavailable, the twin's chat endpoint sees **zero** requests (asserted).
6. The sentinel test proves no contract text appears in logs, error bodies or fs writes.
7. The server binds 127.0.0.1 by default and sends the CSP header. Every non-2xx response matches the error envelope.
8. `npm run twin` serves the UI end to end, and health reports `mode: 'twin'`.

**B: UI**
1. Against `npm run twin`: load each sample, analyze, see clause cards and a green panel listing every check with its `scope` group.
2. Switch twin scripts `tampered_res`, `ATTESTATION_FAILED`, `ATTESTATION_UNAVAILABLE`, `NEAR_AUTH` and `INFERENCE_TIMEOUT` (A exposes them through env `TWIN_SCRIPT=…`). Each shows the correct red or amber state and message, and the "Contract NOT sent" label appears exactly when `contractSent` is false.
3. A .txt upload and a text PDF upload fill the textarea. DevTools Network shows the PDF bytes are **never** sent: only the `/api/analyze` JSON with text leaves the page. Zero console CSP violations.
4. Copy-redline works. A `<script>` string in the twin's model output renders as literal text.
5. Usable at 375 px wide. TWIN banner visible in twin mode.

**C: docs**
1. Following the README from a fresh clone works: `npm ci && npm test` (offline) passes, `npm run twin` shows the UI, and with a key in `.env`, `npm start` plus `npm run verify` work. Every command in the README exists in `package.json`.
2. The README contains the honest-claim paragraph from §1 verbatim, a "What is NOT proven" list (TLS not bound, compose not pinned, our server not attested, NRAS JWT trust), and a zero-retention section with file:line links to the actual code (pull the final line numbers from A's last commit).
3. `docs/api.md` matches §4 exactly. `docs/architecture.md` has an ASCII or Mermaid diagram of the trust chain, Browser → local server → NEAR gateway TEE → model TEE (+ GPU), with the trust boundaries marked.
4. `docs/demo-script.md` is a 2-minute flow with a twin-mode fallback line. `docs/submission-kit.md` covers the one-liner, track, repo URL, video link placeholder, and judge test steps.
5. `LICENSE` is MIT, matching `package.json`. `OUTLINE.md` is no longer empty.

---

## Key file paths

- src/attest.mjs: defects #1–#8 and #23–#25; the `deps` seam goes here.
- src/near.mjs: #9–#18; `setNearDeps` goes here.
- src/server.mjs: #19–#22; `createServer` goes here.
- scripts/verify_tee.mjs: line 24, same raw-bytes fix as #9.
- node_modules/@phala/dcap-qvl/src/collateral.js: lines 194 and 325–331. `getCollateral` returns JSON-safe collateral, and `getCollateralAndVerify` uses wall-clock time and fetch calls with no timeout.
