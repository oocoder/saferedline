# Submission kit

Source rules: [submission-research.md](submission-research.md). Window ends **2026-11-14 23:59 UTC**. Submission cannot be edited afterward (changes via https://nearhackathon.com/request-changes). Submit at https://nearhackathon.com/#apply.

## Form fields

| Field | Value | Who |
|---|---|---|
| projectName | SafeRedline | prefilled |
| leadName | TBD | human |
| email | TBD (max 160 chars) | human |
| size | TBD (one of: 1, 2 - 4, 4 - 6, 6 - 8, 8+) | human |
| tracks | `privacy` (primary) | prefilled |
| nearAddress | mainnet NEAR account for payout (e.g. name.near); never invent one | **human only** |
| projectUrl | TBD: public GitHub repo URL | human, after repo is public |
| demoUrl | TBD: URL of the public X post | **human only** (posting on X) |
| idea | draft below (20-2000 chars) | prefilled |
| consent | tick only after agreeing to the notice verbatim: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." | human |

Do not include a `website` field if submitting via API (spam trap). Submit once; a repeat repo returns 409.

### Track choice

- **privacy**: fits directly (private AI, TEE, NEAR AI Cloud). Select it.
- **security**: arguable, since the project is attestation verification, but the product problem is data confidentiality, not defending a system. Add it only if the human is comfortable defending the fit; the rules say add other tracks only if the project genuinely fits. Recommendation: `privacy` only, or `privacy` + `security` if the form encourages every fitting track.
- `business`: not selected; there is no revenue model in the build.

## X post draft (human posts; agents never post)

Requirements: public, states it was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, video or screenshots attached.

```
An NDA is the one document you can't paste into a chatbot. SafeRedline reviews contracts inside a NEAR AI Cloud TEE: attestation checked per request with a fresh nonce, every answer signed by the enclave, nothing stored. Built at NEAR HACKATHON @buidlcity @NEARProtocol @nearlegion #NEARHackathon
Demo + repo: <repo URL>. What would you want it to flag?
```

(Check length before posting; trim the last line if over the limit.)

## "What did you build?" draft (under 2000 chars)

```
Contracts and NDAs are the documents you cannot paste into a normal AI chatbot: they are confidential, often under NDA themselves, and a regular LLM API gives you no proof of where your text went or whether it was kept.

SafeRedline is a contract and NDA reviewer you run on your own machine. You load a document and an LLM running inside a NEAR AI Cloud confidential VM (Intel TDX plus NVIDIA GPU confidential computing) returns risky clauses with verbatim quotes, plain-English explanations, copy-pasteable redlines, and missing protections. SafeRedline itself stores nothing.

What makes it verifiable: before any contract is sent, the app fetches the gateway and model enclave attestations bound to a fresh nonce and verifies the Intel TDX quote, debug-off, the signing key and nonce in the quote, the compose hash, the RTMR3 event log, and NVIDIA's GPU verdict. If any check fails, the contract is not sent. After the response, it checks the enclave's signature over the exact request and response bytes against the attested key. A panel shows every check.

We are explicit about limits: the TLS connection is not yet pinned to the enclave, enclave software is identified by hash rather than audited, and our local server is not attested (it is open code with no persistence and a test asserting nothing is logged or written).

NEAR is load-bearing: NEAR AI Cloud runs the open-weight model in the TEE and exposes the attestation and signature endpoints we verify against. Without it this is a chatbot with a privacy policy.
```

## Demo video shot list (60 seconds or less)

1. 0-5s: Title text: "An NDA you can't paste into a chatbot." Empty UI.
2. 5-12s: Click Load Predatory NDA; click Analyze privately; stage labels visible.
3. 12-25s: Clause cards; zoom on IP assignment clause and redline; click Copy.
4. 25-42s: Verified TEE panel: nonce, checks green, signature group.
5. 42-50s: Click Verify enclave only; nonce changes.
6. 50-57s: Terminal: `npm run verify` ending in `Verified: true`.
7. 57-60s: End card: repo URL, "Built at NEAR HACKATHON".

## Pre-flight checklist

- [ ] Repo public; README steps work from a fresh clone (`npm ci && npm test`, `npm run twin`)
- [ ] `LICENSE` present (MIT); no `.env` or `sk-` key anywhere in git history
- [ ] README states libraries and "no pre-hackathon code"
- [ ] README zero-retention line links still match `src/` (re-check if code changed)
- [ ] Live run: `npm run verify -- --attest-only` and `npm run verify` show `Verified: true`
- [ ] Demo video or screenshots recorded
- [ ] X post live (**human**): says NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, media attached
- [ ] Mainnet NEAR payout account ready (**human**)
- [ ] Hosted demo up (Q-012: screenshots alone are not enough if judges cannot open a demo); keep up until at least 2026-11-18
- [ ] Submit once, before 2026-11-14 23:59 UTC, with projectUrl and demoUrl exact
