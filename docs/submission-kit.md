# Submission kit

Source rules: [submission-research.md](submission-research.md). Window ends **2026-11-14 23:59 UTC**. Submission cannot be edited afterward (changes via https://nearhackathon.com/request-changes). Submit at https://nearhackathon.com/#apply.

## Final form payload (copy-paste ready)

Rules: [submission-research.md](submission-research.md). Submit once, before 2026-11-14 23:59 UTC, only after the repo is public AND the X post is live. Items marked HUMAN are for the person submitting; an agent must not invent or post them.

| Field | Value |
|---|---|
| projectName | `SafeRedline` |
| teamLead | [confirmed by user, filled at submit time] |
| email | [confirmed by user, filled at submit time] (max 160 chars; do not write it into this public repo) |
| teamSize | `Solo builder` (API value: `1`) |
| tracks | `["privacy"]` |
| nearAddress | `alexmaldonado.near` (confirmed by user) HUMAN: mainnet payout account |
| projectUrl | `https://github.com/oocoder/saferedline` (repo is public) |
| demoUrl | [X post URL, pending: HUMAN posts first; must be `x.com/AlexBuildsNY/status/...`] |
| idea | text below (1797 characters; limit 2000) |
| website | leave EMPTY (spam trap: any non-empty value rejects the submission) |
| consent | `true`, only after the human agrees to this notice verbatim: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

Field name note: the form labels and the API names differ slightly (`leadName` in the API for team lead; `size` for team size). If submitting by API, use the names in [submission-research.md](submission-research.md) and include a `requestId` UUID; show the human the full payload before sending.

### idea (1797 characters)

```
Contracts and NDAs are the documents you cannot paste into a normal AI chatbot: they are confidential, often under NDA themselves, and a regular LLM API gives you no proof of where your text went or whether it was kept.

SafeRedline is a contract and NDA reviewer you run on your own machine. You load a document and an LLM running inside a NEAR AI Cloud confidential VM (Intel TDX plus NVIDIA GPU confidential computing) returns risky clauses with verbatim quotes, plain-English explanations, copy-pasteable redlines and missing protections. SafeRedline itself stores nothing.

What makes it verifiable: before any contract is sent, it fetches the gateway and model attestations bound to a fresh nonce and checks the Intel TDX quote, debug-off, the signing key and nonce in the quote, the compose hash, the RTMR3 log, and NVIDIA's signed GPU verdicts (ES384, nonce, expiry). The contract then travels only over TLS pinned to the key bound inside the attested gateway quote. Afterwards it checks the enclave's per-response signature over the exact request and response bytes against the attested key. Everything fails closed: missing evidence is a failure, and a failed check means the contract is not sent. Live on 2026-11-11, 23 of 23 counted checks passed. 106 offline tests plus a simulated-enclave twin cover the failure paths.

Honest limits: enclave software is identified by hash, not audited or pinned to a published release; the attested gateway and model still see plaintext; our local server is not attested (small open code, no persistence, a test asserts nothing is logged or written).

NEAR is load-bearing: NEAR AI Cloud runs the open-weight model in the TEE and exposes the attestation and signature endpoints we verify against. Without it this is a chatbot with a privacy policy.
```

### Track choice

- **privacy**: fits directly (private AI, TEE, NEAR AI Cloud). Selected.
- **security**: arguable because the project is attestation verification, but the product problem is data confidentiality. Not selected; add only if the human can defend the fit.
- `business`: not selected; there is no revenue model in the build.

## X post (HUMAN posts; agents never post)

Requirements: public post; says it was built at NEAR HACKATHON; tags @NEARProtocol and #NEARHackathon; video or screenshots attached. Counts below treat the link as 23 characters (how X counts links). Optional tags: @buidlcity @nearlegion @NearBuilders (check the length if you add them).

**Variant A (273 chars)** problem first, then the one moment, then NEAR's role:

```
You can't paste an NDA into a chatbot. SafeRedline reviews it inside a NEAR AI Cloud TEE, but only after verifying the enclave live (Intel TDX + NVIDIA, TLS pinned) and checking the signed answer. Built at NEAR HACKATHON @NEARProtocol #NEARHackathon https://github.com/oocoder/saferedline
```

**Variant B (262 chars)** leads with the trust angle instead of the user problem:

```
A privacy policy isn't proof. SafeRedline sends your NDA to a NEAR AI Cloud TEE only after verifying the enclave, then checks the enclave's signature on the answer. Built at NEAR HACKATHON @NEARProtocol #NEARHackathon https://github.com/oocoder/saferedline What should it flag?
```

Tip: put a question as the first reply, e.g. "What clause would you want it to catch first?"

### Posting checklist (HUMAN)

- [ ] Repo is public and `https://github.com/oocoder/saferedline` opens while logged out
- [ ] Attach `.work/demo/saferedline-demo.mp4` (a live-run version is coming; use it if ready) or the 4 stills: `.work/demo/still-1-verified-panel.png`, `still-2-high-risk-report.png`, `still-3-redline-card.png`, `still-4-contract-not-sent.png`
- [ ] Post from @AlexBuildsNY; the `demoUrl` must be an `x.com/AlexBuildsNY/status/...` URL; confirm the text says "Built at NEAR HACKATHON" and tags @NEARProtocol and #NEARHackathon
- [ ] Open the post logged out to confirm it is public, then copy its URL
- [ ] Paste the URL into `demoUrl`; submit once

## Demo video shot list (60 seconds or less)

1. 0-5s: Title text: "An NDA you can't paste into a chatbot." Empty UI.
2. 5-12s: Click Predatory SaaS NDA (High); click Analyze privately; stage labels visible.
3. 12-25s: Clause cards; zoom on IP assignment clause and redline; click Copy.
4. 25-42s: Verified TEE panel: nonce, checks passing, signature group.
5. 42-50s: Click Verify enclave only; nonce changes (live mode).
6. 50-57s: Terminal: `npm run verify` ending in `Verified: true`.
7. 57-60s: End card: repo URL, "Built at NEAR HACKATHON".

## Pre-flight checklist

- [ ] Repo public; README steps work from a fresh clone (`npm ci && npm test`, `npm run twin`)
- [ ] `LICENSE` present (MIT); no `.env` or `sk-` key anywhere in git history
- [ ] README states libraries and built Nov 11 2026 (see git history)
- [ ] README zero-retention line links still match `src/` (re-check if code changed)
- [ ] Live run: `npm run verify -- --attest-only` and `npm run verify` show `Verified: true`
- [ ] Demo video or screenshots recorded
- [ ] X post live (**human**): says NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, media attached
- [ ] Mainnet NEAR payout account ready (**human**)
- [ ] Hosted demo up (Q-012: screenshots alone are not enough if judges cannot open a demo); keep up until at least 2026-11-18
- [ ] Submit once, before 2026-11-14 23:59 UTC, with projectUrl and demoUrl exact
