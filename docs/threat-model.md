# Threat model

## Parties and what each sees

| Party | Sees plaintext? | Trust basis |
|---|---|---|
| You / your browser | yes | you |
| SafeRedline server (your machine) | yes | you run it; code is readable; not attested |
| TLS path to cloud-api.near.ai | no | leaf SPKI sha256 pinned to the fingerprint bound in the attested gateway quote |
| NEAR gateway enclave | yes | Intel TDX attestation |
| Model enclave | yes | Intel TDX + NVIDIA CC attestation |
| Intel / Phala PCCS, NVIDIA NRAS | no (receive quotes/GPU evidence only) | public infrastructure |

## Proven

Before the contract leaves the machine: gateway and every model instance are genuine Intel TDX with accepted TCB and debug off; the quote binds a fresh nonce (live, not replayed) and the enclave signing key; the compose hash is in MRCONFIGID and RTMR3 replays; NVIDIA NRAS says the GPUs are in CC mode against the same nonce (ES384 JWT signature verified against NVIDIA's JWKS; `eat_nonce` and `exp` checked on overall and per-GPU tokens; at least one GPU).
After the response: exact request and response bytes were signed (EIP-191) by a key attested above, so the output came from that enclave and was not modified in transit.

## Hosted demo (optional deployment)

The Vercel-hosted demo adds Vercel as a party that sees the request text. It only ever processes the bundled fictional samples: this is enforced server-side (`403 SAMPLES_ONLY` for anything else), not just in the UI. The hosted server is not a TEE. The attested NEAR gateway and model, and every verification check, behave exactly as in local mode. Real contracts should be reviewed locally. Rate limits are in memory (per instance on serverless); the NEAR key's spend cap is the hard cost backstop. Planned upgrade: run the same container in a TEE (Phala dstack) so the hosted server is attested too.

## Not proven

1. **Gateway and model still see plaintext.** TLS pinning (see (a) below) shows the endpoint is the attested gateway, not that its code is benign; the gateway forwards plaintext to the attested model.
2. **Enclave code behavior.** Compose hash is displayed (pin optional via `EXPECTED_COMPOSE_HASH`), not pinned to a known-good release; image digests vs claimed weights not checked.
3. **Our server.** Not in a TEE. Zero retention is a code-level claim (no DB, no user-data cache, no write paths; evidence: sentinel test in [`tests/pipeline.test.mjs`](../tests/pipeline.test.mjs#L254)). Swap and core dumps are out of scope.
4. **Model correctness.** Output may be wrong; `quoteFound` is only a verbatim-quote guard.

## Deferred limits (from separate-agent review)

- **(a) TLS channel binding: RESOLVED.** The contract and signature calls go only over TLS whose leaf SPKI sha256 equals the fingerprint bound inside the attested gateway quote, checked in the handshake before any bytes are written. A mismatch fails with `ATTESTATION_FAILED` and the contract is not sent. Binding is always enforced: a proxy or CDN in front of the NEAR gateway TEE fails closed.
- **(b) Measurement pinning is optional** (`EXPECTED_COMPOSE_HASH`). We verify the enclave is genuine and which code hash it runs, not that the hash is a NEAR-published release. Fix: pin to known-good published releases.
- **(c) TCB policy matches NEAR's reference verifier** and accepts `OutOfDate`; the status is shown in the UI.
- **(d) Responses carry no per-request nonce**, so replay only matters to a party already holding the plaintext.

Live status (2026-11-11): the signature format (model-prefixed signed text), the reported `ecdsa` algorithm, pinned-TLS completion and signature calls, and signer = attested model key were confirmed against the real NEAR AI Cloud. Non-ASCII: the contractor sample's `sig_req` also passes live with `ASCII_SAFE_JSON` on and off.

## Security review

Full write-up: [security-review.md](security-review.md). A separate-agent adversarial review (self-run, not a third-party audit) found no way to produce `verified: true` from attacker-supplied bytes alone; checks fail closed.

Tested: fail-open paths (missing quote body, compose, gateway, signer, malformed NRAS); that test seams (`deps`, twin) are unreachable from HTTP requests; the sentinel test showing contract text never reaches logs, error bodies or fs writes.

Hardening done: strict signature model and algorithm checks, exact signer-address length, NVIDIA JWT verification with GPU count, nonce and expiry checks, a lock on endpoint overrides (`ALLOW_ENDPOINT_OVERRIDE`), and local CSRF protection (Host/Origin allowlist, JSON-only POST). TLS binding is done (`tls_bound`).

## Fail-closed design

Missing `reportData`, `app_compose`, gateway attestation, attested signer, or malformed NRAS shape each produce a failed check, never a skipped one. PCCS/NRAS outages and timeouts fail closed with an error naming the source. Attestation failure means no contract is sent (asserted in tests: twin chat endpoint receives zero requests).

## Other attacker notes

- Replay: defeated by nonce in quote report_data and GPU evidence.
- Wrong signer / second instance: all instances verified; recovered address must be in the attested set.
- Non-ASCII or BOM bytes causing hash mismatch: raw bytes hashed; ASCII-safe JSON option. Failure shows as `verified: false`, not silent success.
- XSS from model output: UI uses `textContent`; CSP restricts scripts and `connect-src 'self'`.
- Error leakage: parser errors are never forwarded; envelope messages never contain contract text.

Reference: [architecture.md](architecture.md), plan [§1-2](plans/2026-11-11-architecture-plan.md).
