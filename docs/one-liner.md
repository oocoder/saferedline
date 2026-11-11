# One-liner

Template: **We make ______ for ______ who need to ______ so they ______.**

## Recommended

> **We make provably private AI contract review for founders and small legal teams who need to check NDAs before signing, so they catch the traps without trusting a privacy policy.**

## Alternates

- **Imagery:** We make a locked-room contract reviewer for founders and small legal teams who need AI help on confidential deals, so they get redlines in seconds and proof their contract never leaked.
- **Short (pitch opener):** We make verifiable private contract review for founders who need to vet NDAs, so they can sign with confidence.

## How it maps to SafeRedline

| Slot | Answer | Where it's real |
|---|---|---|
| We make | provably private AI contract review | per-request TEE attestation, TLS pinned to the enclave, signed answers |
| for | founders and small legal teams | runs locally; no enterprise sales cycle |
| who need to | check NDAs before signing | flags risky clauses, quotes them verbatim, drafts fair redlines |
| so they | catch the traps without trusting a privacy policy | if any check fails, the contract is never sent |

Live demo: https://saferedline.vercel.app
