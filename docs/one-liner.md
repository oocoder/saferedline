# One-liner

## Hackathon format (20 words or fewer)

Template from the NEAR Private AI Hackathon NYC idea worksheet: **"For [who], [project name] [does what], and it needs private AI because [why]."**

- **A (recommended, 19 words):** For founders, SafeRedline flags contract traps before you sign, and it needs private AI because unsigned deals can't leak.
- **B (20 words):** For small legal teams, SafeRedline redlines NDAs in seconds, and it needs private AI because client secrets must stay sealed.
- **C (19 words):** For deal-makers, SafeRedline reviews contracts in a locked room, and it needs private AI because privacy should be proven.

## "We make" format

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
