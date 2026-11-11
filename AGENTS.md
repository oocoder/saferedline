# AGENTS.md - entry map for SafeRedline

Routes you to the right place. Holds no content; follow the links.

SafeRedline: local contract/NDA reviewer that sends text only to a NEAR AI Cloud TEE after verifying attestation. Index: [OUTLINE.md](OUTLINE.md). Overview: [README.md](README.md).

## Where things live
| Need | Go to |
|---|---|
| Local HTTP server, routes, headers | `src/server.mjs` |
| NEAR client, analysis pipeline, prompts | `src/near.mjs` |
| TEE attestation + signature verification | `src/attest.mjs` |
| CLI proof (live attestation) | `scripts/verify_tee.mjs` |
| Fixture recorder (public data) | `scripts/record_fixtures.mjs` (`npm run record`) |
| Error types and codes | `src/errors.mjs` |
| UI (single file) | `public/index.html` |
| Fictional sample contracts | `samples/` |
| Tests (`tests/*.test.mjs`), twin (`tests/twin/near-twin.mjs`, `install.mjs`), fixtures | `tests/` |
| Approved design, defect list, API contract | `docs/plans/2026-11-11-architecture-plan.md` |
| Trust chain / data flow | `docs/architecture.md` |
| What is and is not proven | `docs/threat-model.md` |
| HTTP API reference | `docs/api.md` |
| Demo flow + judge Q&A | `docs/demo-script.md` |
| Hackathon submission fields | `docs/submission-kit.md`, `docs/submission-research.md` |
| Open items and status | `OUTLINE.md` |

## Run / test / verify
- `npm ci` install
- `npm test` offline suite (no network, no key)
- `npm run twin` UI against a simulated NEAR API (no key); shows TWIN banner; failure modes via lowercase `TWIN_SCRIPT=<name>`
- `npm run record` re-record the attestation fixture (live, no key); rewrites the tracked fixture
- `npm run check:docs` verify README/docs links and commands (also in `npm test`)
- `npm run verify -- --attest-only` live attestation, no key
- `npm start` then `npm run verify` live, needs `NEAR_API_KEY` in `.env`

## Rules
1. Never commit `.env` or any `sk-` key; never read `.env` aloud or paste it anywhere. `.env.example` is the template.
2. Never log, persist or echo contract text: no fs writes, DB, cache, or content in logs/errors. Metadata-only logs.
3. Verification is fail-closed: missing evidence is a failed check, and a failed attestation means the contract is not sent.
4. Do not weaken README claims: the honest-claim paragraph and "What is NOT proven" list must match the code.
5. Do not add dependencies without a reason; prefer Node built-ins.
6. Do not claim "verified" in the UI or docs unless the checks in `src/attest.mjs` ran and passed.

## Which job, which files
- Change verification logic: `src/attest.mjs` + `tests/attest.offline.test.mjs`, `tests/signature.test.mjs`; update `docs/threat-model.md`.
- Change API shape: `src/server.mjs`, `src/near.mjs`, `docs/api.md`, `public/index.html`.
- Change UI: `public/index.html` only.
- Docs or README line links: `README.md`, `docs/`, then run the link check described in `OUTLINE.md`.
- Submission: `docs/submission-kit.md`. Posting on X and payout account are human-only.
