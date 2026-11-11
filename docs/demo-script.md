# Demo script

Two versions: **3 minutes** (if 11-18 teams sign up for the slot) and **5 minutes** (if 10 or fewer). Both use the live app.

Setup before going on stage: `.env` has a valid key; `npm start` running; page open at http://127.0.0.1:3000; Wi-Fi checked; `npm run verify` run once (it passed 23/23 counted checks live on 2026-11-11). Second terminal ready with `npm run twin`.

**Live timings (2026-11-11):** Balanced about 6s, Predatory about 24s, Contractor about 33s, follow-up about 4.5s. Demo with **Predatory SaaS NDA (High)** and talk over the stepper for about 20 seconds.

**If live is slow:** a live analysis takes about 10-30 seconds. Talk over the stepper: "Right now it is attesting the enclave, then it will send the contract, then it checks the enclave's signature. Nothing leaves my laptop until the first step passes."

## Trust panel lines (use in both versions)

Point at each item in order:

1. **Fresh nonce:** "This random number was generated just now, for this one request."
2. **Intel TDX quote:** "Intel's hardware signed a quote that contains that nonce, so this evidence cannot be replayed."
3. **NVIDIA GPUs:** "NVIDIA's attestation service says the GPUs are in confidential-computing mode, against the same nonce."
4. **TLS certificate bound inside the enclave:** "The connection my contract travels over is pinned to a key that is inside the attested gateway, so a relay in front cannot read it."
5. **Signed answer:** "The answer was signed by a key the hardware vouched for, over the exact bytes I sent and received."

## 3-minute version

| Time | Do | Say |
|---|---|---|
| 0:00 | Show the empty UI. | "An NDA is the document you can't paste into a chatbot. SafeRedline reviews it with an AI inside a hardware enclave, and proves it." |
| 0:15 | Click **Predatory SaaS NDA (High)**, then **Analyze privately**. | "Before a byte of this contract leaves my machine, the app verifies the enclave. If that fails, nothing is sent." |
| 0:30 | While it runs, read the stepper. | See "If live is slow" above. |
| 0:50 | Open the IP-assignment clause card (section 3); read quote, risk, redline; click **Copy**. | "Anything I say in meetings becomes theirs, for free. It drafted balanced wording I can paste back." |
| 1:20 | Glance at the other flags: perpetual term, uncapped indemnity, Cayman venue, one-sided definition. | "Five traps in a one-page NDA." |
| 1:35 | Trust panel, walk the five lines above. | (lines above) |
| 2:30 | Click **Verify enclave only**; the nonce changes. | "No contract, anyone can run this check themselves." |
| 2:45 | Close. | "Other AI contract tools promise zero retention. SafeRedline proves where your contract ran." |

## 5-minute version

| Time | Do | Say |
|---|---|---|
| 0:00 | Empty UI. | "Confidential contracts are exactly what people paste into chatbots, and a privacy policy is all they get back." |
| 0:30 | Click **Balanced Mutual NDA (Low)**, analyze. | "A normal NDA first, as a baseline: Low risk, almost nothing flagged." |
| 1:15 | Click **Predatory SaaS NDA (High)**, analyze; talk over the stepper. | See "If live is slow". |
| 1:45 | IP-assignment clause, then perpetual term, indemnity, venue; click **Copy** on a redline. | "Each flag has the verbatim quote, why it is risky, and replacement wording." |
| 2:45 | Trust panel, walk the five lines above, slowly. | (lines above) |
| 3:45 | Terminal: `npm run verify`. | "The same checks from the command line: every counted check passes." |
| 4:15 | Show the limits: README "What is NOT proven". | "Our own server is not attested; the enclave software is identified by hash, not audited. We say so up front." |
| 4:30 | Click **Verify enclave only**. | "Anyone can re-run this." |
| 4:45 | Close. | "Other AI contract tools promise zero retention. SafeRedline proves where your contract ran." |

## Fallback (Wi-Fi or key failure)

Say: "The network's not cooperating, so here is the same flow against the offline twin: a simulated enclave that replays real recorded attestation evidence. The banner says so; it is not a live TEE." Then run `npm run twin`, open the URL, and follow the same table. Also show `npm test` passing offline if time allows.

## Likely judge questions

1. **"So I have to trust your server instead?"** You run it yourself on your own machine; the code is small and readable, has no fs writes, DB or content logging, and a test proves a sentinel string never reaches logs or disk. It is not attested, and we say so. The only third party is NEAR's attested enclaves. Next step: run SafeRedline itself in a TEE.
2. **"What exactly is verified?"** Intel TDX quote against Intel collateral, debug off, our fresh nonce and the signing key in the quote, compose hash in MRCONFIGID, RTMR3 replay, NVIDIA NRAS for the GPUs, then the enclave's signature over our exact request and response bytes.
3. **"What can't you prove?"** The enclave software is identified by hash rather than audited, our server isn't attested. All listed in the README.
4. **"Why NEAR AI Cloud?"** It is what runs the open-weight model inside Intel TDX + NVIDIA confidential computing and exposes the attestation and signing endpoints needed to check it. Without it this is a chatbot with a privacy policy.
5. **"What if the model hallucinates a clause?"** Each flagged clause gets a `quoteFound` check against your contract text, shown as a tag when the quote isn't verbatim. It's informational analysis, not legal advice.
6. **"How is this different from Copilot, Gemini or Harvey?"** Positioning, not a benchmark. Copilot and Gemini for Workspace give contractual privacy commitments, with no customer-verifiable per-request TEE attestation (their clouds sell confidential computing for workloads you deploy yourself, not for these SaaS products). Harvey is enterprise, sales-led, annual multi-seat contracts. SafeRedline makes the enclave claim checkable per request and targets small teams who self-host.
7. **"What about Spellbook, LegalOn, GC AI?"** They compete on contractual zero data retention with their LLM providers; none claims TEEs or verifiable attestation. They promise zero retention; we prove where it ran. (Their retention claims are theirs and unaudited by us; LegalOn's comes from a competitor's comparison page.)
8. **"Is leaking to chatbots a real problem?"** Cyberhaven's 2025 report, which is vendor telemetry and not peer-reviewed, says 34.8% of corporate data employees put into AI tools is sensitive, up from 27.4% a year earlier. Samsung banned internal ChatGPT use in 2023 after engineers pasted source code into it.
9. **"What did you skip that NEAR recommends?"** TLS channel binding is done. NVIDIA JWT verification (ES384 against NVIDIA's JWKS, nonce, expiry, per-GPU tokens) is done. Also not done: verifying image digests' Sigstore provenance.
10. **"Why no pricing comparison with Harvey?"** Harvey publishes no pricing, and reported per-seat numbers vary widely by firm size.
11. **"Could a proxy at NEAR read it?"** Not one in front of the gateway without detection: we pin the TLS leaf certificate key to the fingerprint bound inside the attested gateway quote, and refuse to write any contract bytes if it does not match. What remains: the attested gateway and model themselves see plaintext, and their code is identified by hash, not audited.

See [api.md](api.md) and [threat-model.md](threat-model.md).
