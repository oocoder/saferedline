# Security review log — 2026-11-11

Two independent reviews were run against this repo during the hackathon. Each finding is listed with where it was resolved, so a reader can check it in git history (`git log --oneline`) and in the tests.

## Review 1 — architecture pre-review (before UI build)

Twenty-five issues were raised. The six fail-open paths were fixed with regression tests in `tests/attest.offline.test.mjs` and `tests/signature.test.mjs`, in commit `feat(backend): fail-closed verification…`:

| # | Fail-open path (before) | Now |
|---|---|---|
| 1 | Quote body unparsed → debug/signer/nonce/compose/RTMR3 checks *skipped* | `td_parse` check fails |
| 2 | `app_compose` missing → compose check skipped | compose check always emitted, fails when absent |
| 3 | Only first model instance verified | every `model_attestations[]` entry verified; signer must be in the attested set |
| 4 | `gateway_attestation` missing → no gateway checks | `gateway_present` fails |
| 5 | Undefined attested signer → `sig_attested` skipped | always emitted, fails without a signer set |
| 6 | Signed text split on `:` broke model ids; model not compared | `sig_model` requires exact model prefix |

## Review 2 — adversarial review (after backend, scope: "find any way to get `verified:true` or send the contract when it should not")

The headline finding was that no way was found to produce `verified: true` from attacker-supplied bytes alone. Missing data, empty arrays, exceptions and HTTP-only fields all fail closed. Test/twin seams are not reachable from HTTP requests.

| Finding | Severity | Resolution |
|---|---|---|
| Attestation not bound to the TLS channel the contract travels over (relay risk) | High (design) | **Fixed.** Report requested with `include_tls_fingerprint=true`; `report_data` checked as `sha256(address ‖ SPKI)`; chat + signature calls go over `node:https` pinned to the attested SPKI (checked in the handshake, before any bytes are written). `tls_bound` counted by default. Tests: `tests/pinning.test.mjs`. |
| Verifier doesn't pin *which* enclave software (compose / MRTD) | High (design) | **Partly addressed.** Optional `EXPECTED_COMPOSE_HASH` pin; informational `measurement_pinning` check makes the unpinned state visible. Mandatory pinning to NEAR-published releases is future work (see README "What is NOT proven"). |
| NVIDIA verdict checked loosely (JWT signature, `eat_nonce`, GPU count, exp) | Medium | **Fixed.** ES384 verification against NVIDIA JWKS for the overall and per-GPU tokens; `eat_nonce`, `exp`, ≥1 GPU, and per-GPU `secboot` / `dbgstat` / `measres` claims. Tests: `tests/hardening.test.mjs`. |
| `sig_model` passed with no model prefix | Medium | **Fixed.** Exact match required (`no_model_prefix` twin script + test). |
| TCB policy accepts `OutOfDate` | Medium | **Kept, disclosed.** Same as NEAR's reference verifier; the UI shows amber unless `UpToDate`. |
| `signing_address` silently truncated in `report_data` comparison | Low (confirmed) | **Fixed.** Exact 20-byte address required (test with an over-long signer). |
| Response replay (no per-request nonce in signed text) | Low | **Disclosed.** Only relevant to a party already holding the plaintext, which TLS pinning now prevents. |
| Local CSRF: any web page could POST to the local server and spend the API key | Low | **Fixed.** Host/Origin allowlist (403 `BAD_ORIGIN`), JSON-only POST (415). Tests: `tests/hardening.test.mjs`. |
| `.env` loaded after endpoint config; endpoint overrides unguarded | Low | **Fixed.** `src/env.mjs` loads first; overrides need `ALLOW_ENDPOINT_OVERRIDE=1`, and `/api/health` warns. |

## Review 3 — simulated AI-judge screening (pi-swarm, fresh clone, no API key)

- **judge-repro:** followed the README steps. Reproducibility 9/10; every step ran from a fresh clone, and live `--attest-only` verified.
- **judge-claims:** read-only check of claims against code. All four Privacy-track requirements PASS. It flagged documentation drift: check counts, line links, TLS wording, and twin nonce/analysis behaviour. These were fixed in the follow-up commits, and `npm run check:docs` now guards line links in `npm test`.

## Not reviewed

- The NEAR gateway/model enclave software itself. We verify its identity (hash), not its behaviour.
- Browser-side PDF parsing (pdf.js from cdnjs, with SRI).
