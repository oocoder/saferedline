# Threat model

## Parties and what each sees

| Party | Sees plaintext? | Trust basis |
|---|---|---|
| You / your browser | yes | you |
| SafeRedline server (your machine) | yes | you run it; code is readable; not attested |
| TLS path to cloud-api.near.ai (front proxy / LB) | possibly | WebPKI only, not bound to enclave |
| NEAR gateway enclave | yes | Intel TDX attestation |
| Model enclave | yes | Intel TDX + NVIDIA CC attestation |
| Intel / Phala PCCS, NVIDIA NRAS | no (receive quotes/GPU evidence only) | public infrastructure |

## Proven

Before the contract leaves the machine: gateway and every model instance are genuine Intel TDX with accepted TCB and debug off; the quote binds a fresh nonce (live, not replayed) and the enclave signing key; the compose hash is in MRCONFIGID and RTMR3 replays; NVIDIA NRAS says the GPUs are in CC mode against the same nonce (ES384 JWT signature verified against NVIDIA's JWKS; `eat_nonce` and `exp` checked on overall and per-GPU tokens; at least one GPU).
After the response: exact request and response bytes were signed (EIP-191) by a key attested above, so the output came from that enclave and was not modified in transit.

## Not proven

1. **Transport binding.** `include_tls_fingerprint=false`. Plaintext goes over ordinary TLS; nothing proves the endpoint is the attested gateway. Signature check gives integrity after the fact, not confidentiality. Planned: SPKI fingerprint comparison as an informational check.
2. **Enclave code behavior.** Compose hash is displayed, not pinned to a known-good release; image digests vs claimed weights not checked.
3. **Our server.** Not in a TEE. Zero retention is a code-level claim (no fs writes, DB, content logs). Swap and core dumps are out of scope.
4. **Model correctness.** Output may be wrong; `quoteFound` is only a verbatim-quote guard.

## Deferred limits (from independent review)

- **(a) No TLS channel binding.** A relay in front of NEAR could see plaintext while attestation and signature still verify, because nothing ties the TLS endpoint to the attested enclave. Fix: `include_tls_fingerprint` compared to the live certificate, or end-to-end encryption to the attested key.
- **(b) Measurement pinning is optional** (`EXPECTED_COMPOSE_HASH`). We verify the enclave is genuine and which code hash it runs, not that the hash is a NEAR-published release. Fix: pin to known-good published releases.
- **(c) TCB policy matches NEAR's reference verifier** and accepts `OutOfDate`; the status is shown in the UI.
- **(d) Responses carry no per-request nonce**, so replay only matters to a party already holding the plaintext.

## Security review

An independent adversarial review found no way to produce `verified: true` from attacker-supplied bytes alone; checks fail closed.

Tested: fail-open paths (missing quote body, compose, gateway, signer, malformed NRAS); that test seams (`deps`, twin) are unreachable from HTTP requests; the sentinel test showing contract text never reaches logs, error bodies or fs writes.

Hardening done: strict signature model and algorithm checks, exact signer-address length, NVIDIA JWT verification with GPU count, nonce and expiry checks, a lock on endpoint overrides (`ALLOW_ENDPOINT_OVERRIDE`), and local CSRF protection (Host/Origin allowlist, JSON-only POST). In progress: TLS binding (currently an informational `tls_bound` check).

## Fail-closed design

Missing `reportData`, `app_compose`, gateway attestation, attested signer, or malformed NRAS shape each produce a failed check, never a skipped one. PCCS/NRAS outages and timeouts fail closed with an error naming the source. Attestation failure means no contract is sent (asserted in tests: twin chat endpoint receives zero requests).

## Other attacker notes

- Replay: defeated by nonce in quote report_data and GPU evidence.
- Wrong signer / second instance: all instances verified; recovered address must be in the attested set.
- Non-ASCII or BOM bytes causing hash mismatch: raw bytes hashed; ASCII-safe JSON option. Failure shows as `verified: false`, not silent success.
- XSS from model output: UI uses `textContent`; CSP restricts scripts and `connect-src 'self'`.
- Error leakage: parser errors are never forwarded; envelope messages never contain contract text.

Reference: [architecture.md](architecture.md), plan [§1-2](plans/2026-11-11-architecture-plan.md).
