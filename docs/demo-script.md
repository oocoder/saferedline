# Demo script (2 minutes, live)

Setup before going on stage: `.env` has a valid key; `npm start` running; page open at http://127.0.0.1:3000; Wi-Fi checked; `npm run verify -- --attest-only` run once to confirm the network path. Second terminal ready with `npm run twin`.

| Time | Do | Say |
|---|---|---|
| 0:00 | Show the empty UI. | "This is the document you can't paste into a chatbot: an NDA. SafeRedline reviews it with an AI that runs inside a hardware enclave, and proves it." |
| 0:15 | Click **Load Predatory NDA**. | "A fictional but realistic one-sided NDA." |
| 0:20 | Click **Analyze privately**. Point at the stages: Attesting enclave, Running in TEE, Verifying signature. | "Before a single byte of this contract leaves my machine, the app verifies the enclave. If that fails, nothing is sent." |
| 0:40 | Open the IP-assignment clause card (section 3). Read the quote, the risk, then the suggested redline. Click **Copy**. | "It caught that anything I say in meetings becomes theirs, without compensation, and drafted balanced replacement wording I can paste back." |
| 1:00 | Glance at the other flags: perpetual term, uncapped indemnity, Cayman venue, one-sided definition. | "Five traps in a one-page NDA." |
| 1:10 | Right panel, Verified TEE: point at the nonce. | "This nonce was generated fresh for this request. The Intel TDX hardware quote contains it, so this evidence can't be replayed." |
| 1:25 | Point at the checks: Intel quote, debug off, compose hash, GPU verdict, then signature group. | "Intel TDX plus NVIDIA GPU confidential computing, every counted check passing. And the answer itself was signed by a key proven to be inside that enclave." |
| 1:40 | Click **Verify enclave only**; in live mode the nonce changes (in twin mode it is the recorded one). | "No contract, no key needed: anyone can run this check themselves." |
| 1:50 | Closing line. | "Privacy you can check, not a promise you have to trust. SafeRedline: private contract review on NEAR AI Cloud." |

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
