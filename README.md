# SafeRedline

Review confidential contracts and NDAs with an LLM that runs inside a NEAR AI Cloud hardware enclave (TEE), and verify that claim cryptographically on every request instead of trusting a privacy policy.

Built at NEAR HACKATHON (Build City x NEAR Legion, NYC), Nov 11 2026. Track: Privacy & Private AI. License: MIT.

## The problem

An NDA or term sheet is the document you cannot paste into a normal chatbot: it is confidential, often under NDA itself, and a standard LLM API gives you no proof of where the text went or whether it was kept. People either skip AI review or leak the document. Context: Cyberhaven's 2025 report (vendor telemetry, not peer-reviewed) puts 34.8% of corporate data employees enter into AI tools at "sensitive"; in 2023 Samsung engineers pasted proprietary code into ChatGPT and the company banned internal use. Sources: [docs/judge-qa-research.md](docs/judge-qa-research.md).

## Who it is for

Founders and small legal teams who run SafeRedline **on their own machine** (the server binds to `127.0.0.1`). The only outside party that sees your contract text is NEAR AI Cloud's attested gateway and model enclaves. There is no SafeRedline-operated cloud in the path.

## What it does

1. You load or paste a contract (`.txt`, text `.pdf`, or a bundled fictional sample).
2. The local server fetches a fresh enclave attestation (bound to a new random nonce) and verifies it. If verification fails, **the contract is not sent**.
3. The contract is analyzed by `z-ai/glm-5.3-flash` (a NEAR AI Cloud Confidential TEE model). You get an overall risk rating, flagged clauses (verbatim quote, why it is risky, copy-pasteable redline), and missing standard protections.
4. The enclave's signature over the exact request and response bytes is checked against the attested key. The UI shows every check in a "Verified TEE" panel and turns red if any fails.

## Quickstart

Requires Node >= 20. Steps are numbered "do X, you should see Y".

1. `npm ci` -> installs 2 runtime dependencies (`ethers`, `@phala/dcap-qvl`); no errors.
2. `npm test` -> all tests pass **offline** (recorded real attestation fixture plus a local twin of the NEAR API).
3. `npm run twin` -> prints a localhost URL. Open it: the UI loads with a "TWIN MODE: simulated enclave, not a real TEE" banner. No API key needed. Click a sample, then **Analyze privately**.
4. `npm run verify -- --attest-only` -> **live**, no key needed. Prints about 22 green check marks (Intel TDX quote, nonce binding, compose hash, RTMR3 replay, NVIDIA GPU verdict, ...) and ends with `Verified: true`.
5. `cp .env.example .env`, then set `NEAR_API_KEY=sk-...` (claim a key at https://nearbuilders.org/dashboard). `.env` is git-ignored.
6. `npm start` -> prints `SafeRedline running -> http://127.0.0.1:3000`, `API key: configured`.
7. `npm run verify` -> live attestation, one real private completion, and the response-signature checks; ends with `Verified: true`.

## Try it as a judge

| Do | You should see |
|---|---|
| `npm run twin`, open the URL | UI with the TWIN banner. Everything below also works here, but the enclave is simulated. |
| Click **Load Predatory NDA**, then **Analyze privately** | Overall risk **High**; clause cards for one-sided confidentiality, perpetual term, IP assignment of feedback, uncapped indemnity, Cayman venue. |
| Open the right-hand "Verified TEE" panel | A fresh 64-hex nonce, model id, signer address, compose hash, MRTD, TCB status, GPU count, and a grouped list of checks, all green. |
| Click **Verify enclave only** | Calls `GET /api/attest` (no key needed in live mode); nonce changes every click. |
| Live mode (`npm start` with a key): repeat the above | Same panel, but the checks ran against NEAR's real Intel TDX + NVIDIA evidence. |
| Load the Balanced NDA | Overall risk **Low**, few or no flagged clauses (baseline comparison). |
| Tamper test (twin): `TWIN_SCRIPT=tampered_res npm run twin`, analyze | Panel turns red: **UNVERIFIED RESPONSE**. The signature no longer matches the bytes received. |
| Failure test (twin): `TWIN_SCRIPT=attestation_failed npm run twin`, analyze | Red "Contract NOT sent". The model endpoint receives zero requests. |

Twin scripts (lowercase `TWIN_SCRIPT` values such as `ok`, `tampered_res`, `wrong_signer`, `attestation_failed`, `attestation_unavailable`, `near_auth`, `inference_timeout`, `xss`) are defined in `tests/twin/near-twin.mjs`; see [docs/api.md](docs/api.md) and [docs/demo-script.md](docs/demo-script.md).

## How NEAR is used

- **NEAR AI Cloud, OpenAI-compatible API** at `https://cloud-api.near.ai/v1`: `POST /v1/chat/completions` for the analysis, `GET /v1/models` to list Confidential TEE models (`owned_by == "nearai"`).
- **Model:** `z-ai/glm-5.3-flash`, an open-weight model served in a Confidential TEE (Intel TDX CPU enclave plus NVIDIA GPU confidential computing). Override with `NEAR_MODEL` in `.env`.
- **`GET /v1/attestation/report?model=...&nonce=...&signing_algo=ecdsa`**: returns Intel TDX quotes and NVIDIA GPU evidence for the NEAR gateway and the model enclave, bound to our nonce.
- **`GET /v1/signature/{chat_id}?model=...&signing_algo=ecdsa`**: returns the enclave's signature over `model:sha256(request):sha256(response)`.
- NEAR AI Cloud is what puts the model inside the TEE and publishes the keys and evidence needed to check it. Without it this would be an ordinary chatbot with a privacy policy.

Procedure follows https://docs.near.ai/cloud/verification and NEAR's reference verifier (https://github.com/nearai/nearai-cloud-verifier).

## Cryptographic verification

Run per request, in this order, before and after the contract is sent. Any failed check means `verified: false`; missing evidence counts as a failure (fail-closed). See [docs/architecture.md](docs/architecture.md) and the code in [`src/attest.mjs`](src/attest.mjs).

**Before the contract leaves your machine** (for the model enclave, every model instance returned, and the gateway enclave):

| Check | What it proves |
|---|---|
| Fresh nonce generated per request (`crypto.randomBytes(32)`) | Evidence cannot be a replay of an old attestation. |
| `nonce_echo`: enclave echoes our nonce | The report was produced for this request. |
| `tdx_quote`: Intel TDX quote verified with `@phala/dcap-qvl` against Intel collateral | The evidence was signed by genuine Intel TDX hardware; TCB status is reported (green only for `UpToDate`). |
| `td_parse`: quote body parses as a TD report | The checks below really ran (no silent skip). |
| `tdx_debug`: debug bit off | The enclave is a production VM, not a debuggable one whose memory the host could read. |
| `rd_signer`: quote `report_data` binds the enclave signing address | The key that later signs responses lives inside the attested enclave. |
| `rd_nonce`: quote `report_data` binds OUR nonce | The hardware itself vouches for freshness, not just the API JSON. |
| `compose`: `sha256(app_compose)` equals the value in MRCONFIGID | The docker-compose (software manifest) is the one the hardware measured. |
| `rtmr3`: RTMR3 runtime event-log replay matches the quote | The runtime events are the ones extended into the measured register. |
| `compose_event`: the `compose-hash` runtime event equals `sha256(app_compose)` | The measured event log and the manifest agree. |
| `compose_pinned` (only if `EXPECTED_COMPOSE_HASH` is set) | The enclave software matches a hash you chose to trust. |
| `gpu_nonce` and `gpu`: NVIDIA evidence carries our nonce and NVIDIA NRAS reports the GPUs in confidential-computing mode | The GPU that sees plaintext is a genuine confidential-computing GPU, fresh for this request. |
| `gateway_present`, `model_present` | Both enclaves that see plaintext were actually attested. |

**After the response returns:**

| Check | What it proves |
|---|---|
| `sig_req`: signed request hash equals sha256 of the exact bytes we sent | The enclave saw our request, unmodified. |
| `sig_res`: signed response hash equals sha256 of the exact bytes received | The answer was not altered in transit. |
| `sig_algo`: signature algorithm is ECDSA | No algorithm downgrade. |
| `sig_ecdsa`: EIP-191 signature recovers to the signing address | The signature is valid. |
| `sig_attested`: recovered address is in the set of keys attested above | The answer came from the attested enclave, not some other key. |
| `sig_model`: signed model id equals the model we asked for | The enclave served the model we requested. |
| `sig_fetch`: signature retrieved from the enclave | A missing signature is a failure, not a pass. |

The authoritative check list is whatever `GET /api/attest` returns (22 checks live, since the model enclave, gateway enclave and GPU each contribute); ids are defined in `src/attest.mjs`. Design rationale: the architecture plan ([docs/plans/2026-11-11-architecture-plan.md](docs/plans/2026-11-11-architecture-plan.md)).

## The honest claim

> SafeRedline runs on your machine and sends your contract only to a NEAR AI Cloud model after cryptographically verifying, with a fresh nonce, that the model and gateway run in genuine Intel TDX + NVIDIA confidential-computing enclaves. Every answer is checked against an enclave-held key bound to that attestation. SafeRedline itself stores nothing. Limits: the TLS connection is not pinned to the enclave, and the enclave's software is identified by hash, not audited.

### What is NOT proven

- **TLS is not bound to the enclave.** The attestation report is requested with `include_tls_fingerprint=false`. We do not prove the TLS endpoint we sent plaintext to is the attested gateway; a front proxy or load balancer before the TEE is trusted only via ordinary WebPKI. The response signature gives integrity after the fact, not confidentiality.
- **Enclave software is identified by hash, not audited.** We show the compose hash but do not pin it to a known-good NEAR release or verify that image digests serve the claimed weights. "No retention inside NEAR" rests on the attested compose being what NEAR publishes.
- **SafeRedline's own server is not attested.** It is not in a TEE and sees plaintext. "Zero retention" on our side is a code-level claim you can verify by reading the code, not a hardware-attested one. OS swap and core dumps are out of scope.
- **NVIDIA NRAS verdict is trusted via TLS (JWT signature not verified).** We decode the NRAS JWT claims but do not verify its signature against NVIDIA's JWKS yet.
- **Intel TCB status may be `OutOfDate`/`SWHardeningNeeded`.** Our TCB policy matches NEAR's reference verifier, which accepts these, and the status is shown in the UI; they mean a genuine quote on a platform behind Intel's latest advisories.
- **A relay in front of NEAR could see plaintext while verification still passes.** There is no TLS channel binding (see the first item). Planned fix: request `include_tls_fingerprint` and compare it to the live certificate, or end-to-end encrypt to the attested key.
- **Measurement pinning is optional.** Setting `EXPECTED_COMPOSE_HASH` pins the code hash; otherwise we verify the enclave is genuine and which code hash it runs, not that the hash is a NEAR-published release. Planned fix: ship a pinned list of known-good releases.
- **Responses carry no per-request nonce.** Replay of a response only matters to a party that already holds the plaintext, so we treat it as out of scope; the attestation itself is nonce-bound.
- Model output is untrusted text and can be wrong or hallucinated; `quoteFound` flags clauses whose quote is not verbatim in your contract. This is informational analysis, not legal advice.

Details: [docs/threat-model.md](docs/threat-model.md).

## Zero data retention

Contract text and model output live only in local variables for the duration of one HTTP request. Links are to the code that enforces or demonstrates it (line numbers synced at final commit):

- No database, file writes, cache or session store in the server (only read-only loads of the UI and samples): [`src/server.mjs#L1-L16`](src/server.mjs#L1-L16)
- Request body read into a variable, dropped after use: [`src/server.mjs#L105`](src/server.mjs#L105) and [`#L114`](src/server.mjs#L114)
- Logs are metadata only (method, path, status, ms); never content: [`src/server.mjs#L130-L131`](src/server.mjs#L130-L131)
- `Cache-Control: no-store` and CSP `connect-src 'self'` (the page cannot send the contract anywhere but your localhost server): [`src/server.mjs#L42-L46`](src/server.mjs#L42-L46)
- Server binds `127.0.0.1` by default: [`src/server.mjs#L138`](src/server.mjs#L138) and [`#L146`](src/server.mjs#L146)
- Attestation gate: the contract is never sent unless attestation verified (`attestOrThrow`): [`src/near.mjs#L181-L195`](src/near.mjs#L181-L195), called at [`#L202`](src/near.mjs#L202) and [`#L228`](src/near.mjs#L228). Contract text is held only in call-local variables in `analyzeContract` ([`#L199`](src/near.mjs#L199)).
- Response-signature verification (after inference): [`src/attest.mjs#L297`](src/attest.mjs#L297)
- Attestation verifier entry points: [`verifyOne` `src/attest.mjs#L155`](src/attest.mjs#L155), [`attestModel` `#L241`](src/attest.mjs#L241); the module performs no disk writes or content logging.
- Test that proves it: a sentinel string `ZXQ-SECRET-7731` is analyzed and asserted absent from logs, error bodies and filesystem writes: [`tests/pipeline.test.mjs#L193`](tests/pipeline.test.mjs#L193)
- Browser: no `localStorage` of contract text; PDFs are parsed in the browser and only extracted text is sent.

## Architecture

```mermaid
flowchart LR
  subgraph YOURS["Your machine (trusted by you, NOT attested)"]
    B["Browser UI<br/>public/index.html"] -->|"localhost JSON<br/>CSP connect-src self"| S["SafeRedline server<br/>src/server.mjs, 127.0.0.1<br/>sees plaintext, stores nothing"]
    S --> V["Verifier<br/>src/attest.mjs"]
  end
  S -->|"TLS (WebPKI, not pinned)"| GW
  subgraph NEAR["NEAR AI Cloud (attested)"]
    GW["Gateway TEE<br/>Intel TDX, sees plaintext"] --> M["Model TEE<br/>Intel TDX + NVIDIA GPU CC<br/>z-ai/glm-5.3-flash"]
  end
  V -.->|"quotes, nonce"| GW
  V -.->|"GPU evidence"| NRAS["NVIDIA NRAS"]
  V -.->|"collateral"| PCCS["Intel PCS / Phala PCCS"]
```

More: [docs/architecture.md](docs/architecture.md).

## Libraries and provenance

- Runtime: [`ethers`](https://www.npmjs.com/package/ethers) (EIP-191 signature recovery), [`@phala/dcap-qvl`](https://www.npmjs.com/package/@phala/dcap-qvl) (Intel TDX quote verification). Node built-ins for everything else (`node:http`, `node:crypto`, `node:test`).
- Browser: [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 loaded from cdnjs (with SRI) for in-browser PDF text extraction. No other front-end dependencies.
- No pre-hackathon code: no templates, boilerplate or earlier libraries. Everything in this repository was written on Nov 11 2026 during the event.
- Sample contracts in `samples/` are entirely fictional (company names and terms invented).

## Sample documents (fictional)

- [`samples/sample_predatory_nda.txt`](samples/sample_predatory_nda.txt): one-sided "mutual" NDA with perpetual term, IP assignment of feedback, uncapped indemnity, Cayman venue. Expected risk: High.
- [`samples/sample_balanced_nda.txt`](samples/sample_balanced_nda.txt): standard mutual NDA. Expected risk: Low.
- [`samples/sample_contractor_agreement.txt`](samples/sample_contractor_agreement.txt): contractor agreement; also used as the non-ASCII (smart quotes, section sign) signature test input.

## Positioning (not a verified benchmark)

How we frame the product, not a measured comparison. Sources and caveats: [docs/judge-qa-research.md](docs/judge-qa-research.md).

- **Word / Google Docs:** formatting and Track Changes tools; they do not analyze a contract for traps or draft replacement language.
- **Microsoft Copilot / Gemini for Workspace:** privacy rests on contractual commitments; neither offers a customer-verifiable, per-request TEE attestation for these SaaS products.
- **Harvey:** enterprise, sales-led, annual multi-seat contracts. We make no pricing comparison.
- **SMB contract-review tools (Spellbook, LegalOn, GC AI):** compete on contractual zero data retention with LLM providers; none claims TEEs or verifiable attestation. In one line: they promise zero retention; we prove where it ran (within the limits above).

## Roadmap (not built)

Hosted demo; running SafeRedline itself in a TEE (dstack CVM) to close the "our server sees plaintext" gap; TLS fingerprint binding and per-GPU NVIDIA JWT checks (both recommended by NEAR's near-ai-cloud skill; in progress); pinning the compose hash to a known NEAR release; batch review.

## Project layout

See [AGENTS.md](AGENTS.md) (entry map) and [OUTLINE.md](OUTLINE.md) (index).

## Disclaimer

Informational analysis only; not legal advice.

## License

[MIT](LICENSE)
