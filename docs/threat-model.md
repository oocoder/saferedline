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

Before the contract leaves the machine: gateway and every model instance are genuine Intel TDX with accepted TCB and debug off; the quote binds a fresh nonce (live, not replayed) and the enclave signing key; the compose hash is in MRCONFIGID and RTMR3 replays; NVIDIA NRAS says the GPUs are in CC mode against the same nonce.
After the response: exact request and response bytes were signed (EIP-191) by a key attested above, so the output came from that enclave and was not modified in transit.

## Not proven

1. **Transport binding.** `include_tls_fingerprint=false`. Plaintext goes over ordinary TLS; nothing proves the endpoint is the attested gateway. Signature check gives integrity after the fact, not confidentiality. Planned: SPKI fingerprint comparison as an informational check.
2. **Enclave code behavior.** Compose hash is displayed, not pinned to a known-good release; image digests vs claimed weights not checked.
3. **Our server.** Not in a TEE. Zero retention is a code-level claim (no fs writes, DB, content logs). Swap and core dumps are out of scope.
4. **NRAS JWT.** Claims decoded, signature not verified against NVIDIA JWKS; verdict trusted via TLS.
5. **Model correctness.** Output may be wrong; `quoteFound` is only a verbatim-quote guard.

## Fail-closed design

Missing `reportData`, `app_compose`, gateway attestation, attested signer, or malformed NRAS shape each produce a failed check, never a skipped one. PCCS/NRAS outages and timeouts fail closed with an error naming the source. Attestation failure means no contract is sent (asserted in tests: twin chat endpoint receives zero requests).

## Other attacker notes

- Replay: defeated by nonce in quote report_data and GPU evidence.
- Wrong signer / second instance: all instances verified; recovered address must be in the attested set.
- Non-ASCII or BOM bytes causing hash mismatch: raw bytes hashed; ASCII-safe JSON option. Failure shows as `verified: false`, not silent success.
- XSS from model output: UI uses `textContent`; CSP restricts scripts and `connect-src 'self'`.
- Error leakage: parser errors are never forwarded; envelope messages never contain contract text.

Reference: [architecture.md](architecture.md), plan [§1-2](plans/2026-11-11-architecture-plan.md).
