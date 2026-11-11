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
| idea | text below (1629 characters; limit 2000) |
| website | leave EMPTY (spam trap: any non-empty value rejects the submission) |
| consent | `true`, only after the human agrees to this notice verbatim: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

Alternative path: HACKATHON.md allows an agent to file the submission via the API after the human confirms the full payload. The agent must show the whole payload, wait for the human's OK, send it once with a single `requestId`, and never include a `website` field.

Field name note: the form labels and the API names differ slightly (`leadName` in the API for team lead; `size` for team size). If submitting by API, use the names in [submission-research.md](submission-research.md) and include a `requestId` UUID; show the human the full payload before sending.

### idea (1629 characters)

```
An NDA is the one document you can't paste into a chatbot. It's confidential, often under NDA itself, and a normal AI service gives you a privacy policy, not proof.

SafeRedline is a contract and NDA reviewer you run on your own computer. You load a contract. It flags the risky clauses, quotes them word for word, explains the trap in plain English, and drafts a fairer replacement you can paste back. SafeRedline stores nothing.

The AI runs on NEAR AI Cloud, inside a hardware "locked room" (a TEE: Intel TDX plus NVIDIA confidential GPUs). The part I care about most is that you can check the lock.

Before your contract leaves your machine, SafeRedline asks the room to prove itself, using a fresh random number so an old proof can't be replayed. It checks Intel's and NVIDIA's signed evidence, confirms the connection is pinned to the key inside that room, and only then sends the text. When the answer comes back, it checks the room's signature on the exact words sent and received.

If any check fails, nothing is sent. Missing evidence counts as a failure too. Live, every counted check passed (23 before sending, 29 with the signed answer), and 100+ offline tests plus a simulated twin cover the failure paths.

What it can't prove: the enclave software is identified by its hash, not audited; the NEAR gateway and model still see your text inside the room; and my own local server isn't attested.

NEAR makes this possible. Without NEAR AI Cloud, this is a chatbot with a promise. With it, privacy is something you can check.

Other AI contract tools promise zero retention. SafeRedline proves where your contract ran.
```

### Track choice

- **privacy**: fits directly (private AI, TEE, NEAR AI Cloud). Selected.
- **security**: arguable because the project is attestation verification, but the product problem is data confidentiality. Not selected; add only if the human can defend the fit.
- `business`: not selected; there is no revenue model in the build.

## X post (HUMAN posts; agents never post)

Requirements (Build City hackpack section 6): public post; says it was built at NEAR HACKATHON; tags @buidlcity, @NEARProtocol, @nearlegion and #NEARHackathon (all four are in both variants); video or screenshots attached. Counts treat the link as 23 characters (how X counts links). @NearBuilders is optional (recount if added).

**POSTED (variant A) (278 chars)** problem first, then the one moment, then NEAR's role:

```
Can't paste an NDA into a chatbot. SafeRedline reviews it in a NEAR AI Cloud TEE, only after verifying the enclave (Intel TDX, NVIDIA, pinned TLS) and checking the signed answer. Built at NEAR HACKATHON @buidlcity @NEARProtocol @nearlegion #NEARHackathon https://github.com/oocoder/saferedline
```

**Variant B (264 chars)** leads with the trust angle instead of the user problem:

```
A privacy policy isn't proof. SafeRedline sends your NDA to a NEAR AI Cloud TEE only after verifying the enclave, then checks the enclave's signature on the answer. Built at NEAR HACKATHON @buidlcity @NEARProtocol @nearlegion #NEARHackathon https://github.com/oocoder/saferedline
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
