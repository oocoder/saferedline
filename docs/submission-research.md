# Submission research (gathered by Muse from nearhackathon.com/HACKATHON.md, SUBMITTING.md, 00-setup.md — Nov 11 2026)

(a) SUBMISSION CHECKLIST
Timing and hard rules
Development/submission window: 2026-11-01T00:00:00Z to 2026-11-14T23:59:00Z. Repo must be public by the deadline. Outside the window the API returns 403; do not retry.
No sign-up beforehand: the submission itself is the only registration. One submission per project, and each repository can be submitted only once. One email can send at most 2 submissions, for independent, mutually disclosed projects only.
Submit only after the repo is public AND the demo post is live. A submission cannot be edited; mistakes are fixed via (human enters the email, NEAR account and repo link exactly as submitted, ticks the fields to change, leaves a Discord/Telegram handle). Never submit twice: a repeat repo gets 409.
Submit only after the repo is public AND the demo post is live. A submission cannot be edited; mistakes are fixed via 
https://nearhackathon.com/request-changes
 (human enters the email, NEAR account and repo link exactly as submitted, ticks the fields to change, leaves a Discord/Telegram handle). Never submit twice: a repeat repo gets 409.
Optional but relevant: a local-only demo is allowed, but if judges cannot open a hosted demo, screenshots alone are not enough (Q-012); keep a hosted demo up until at least 2026-11-18, ideally 2026-11-25.
Fields (the #apply form mirrors the submission API contract; send exactly these, nothing extra)
requestId (API only): a UUID generated once per submission; reuse the same value on any retry after a network error or 503, or you risk a duplicate.
projectName: 2-80 characters. ("SafeRedline" fits.)
leadName: team lead's name, 2-80 characters.
email: valid email, max 160 characters.
size: exactly one of 1, 2 - 4, 4 - 6, 6 - 8, 8+ (the form labels them "Solo builder, 2 - 4 people," etc.).
tracks: one or more ids from defi, thesis, privacy, business, swarms, security, agents, realworld, games, nfts, memecoins, social, open, each listed once. SafeRedline fits "privacy" (Privacy & Private AI; hints: PRIVATE AI, TEE, NEAR AI CLOUD). Add others only if the project genuinely fits them.
nearAddress: mainnet NEAR account for prize payout, 2-64 chars, lowercase, named (e.g. team.near) or a 64-character implicit account. The human creates it in a NEAR wallet; never invent one.
projectUrl: http(s) URL of the public repository, max 300 characters.
demoUrl: http(s) URL of the public X demo post, max 300 characters.
idea: the "What did you build?" text, 20-2000 characters (problem, product, how NEAR fits in). Draft in (d) below.
consent: true, only after agreeing to the notice verbatim: "I agree that the organizers may use these details to review our submission and contact us about this hackathon."
API trap to avoid if you submit via API instead of the form: do NOT include a "website" field; it is a spam trap and any non-empty value rejects the submission. Body limit 12000 bytes. Responses: 201 = saved; 400 = fix the fields named in the response and resend with the same requestId; 409 = repo already submitted or email limit hit; 413 = body too large; 503 = wait a minute, resend with same requestId.
README expectations (Claude Code and Codex screen every project before the human jury; Q-017: reproducibility check, feature verification, structured report, preliminary score; a low AI score alone cannot reject, humans decide)
README from day one, written for a machine reader as much as a human: what the product is, the problem it solves, and how to try it as numbered "do X, see Y" steps a judge can follow. No marketing copy.
List all libraries, templates, boilerplate and any of your own pre-hackathon libraries used; your own old libs count as baseline (Q-005). Code written from the 2026-10-19 announcement counts; earlier commits are baseline (Q-001). If the project pre-exists on another chain, only the NEAR integration built in the window is judged, and that must be disclosed in the README (Q-002).
No keys or secrets anywhere in the repo history; keys belong in environment variables / .env, never in the repo.
Add a LICENSE file (any license; MIT is fine). Repo stays public through judging.
X demo post requirements and "demo post tips"
Requirements: posted by the human (an agent may draft, never post); public post; states the project was built at NEAR HACKATHON; tags @NEARProtocol and #NEARHackathon; demo video or screenshots attached; you then use the post's URL as demoUrl.
Tips, verbatim in substance from HACKATHON.md "A good demo post": (1) Lead with the user problem; make the first line understandable to someone who doesn't know your project. (2) Show one complete moment: a real user action to a visible result; skip long intros, architecture slides, and setup. (3) Explain NEAR's role concretely (e.g. private inference), not a vague "powered by NEAR". (4) Give people a next step: link the demo and public repo, and ask a genuine question or invite specific feedback. @NearLegion and @NearBuilders are optional tags for community amplification.
SUBMITTING.md pre-flight (their own checklist): repo public with "do X, see Y" README steps; demo post live, says NEAR HACKATHON, video or screenshots attached; mainnet NEAR payout account ready; every fitting track selected; no keys/secrets in repo history; submitting before Nov 14, 2026, 23:59 UTC. If submitting via API, the agent must show the human the full payload and wait for their OK before sending.
(b) README / REPO CONVENTIONS THEY ASK FOR
README.md is the only mandated file, with the content above; there is no required section template beyond what it is / problem / numbered "do X, see Y" try-it steps.
LICENSE file expected (Q-014).
No new repo is required: for an existing project, use a dedicated branch, or tag pre-hackathon and hackathon-submission, plus a README section linking the diff (Q-003).
If one person submits 2 projects, each project's README must name the other project (Q-015).
No HACKATHON.md or AGENTS.md is asked for inside your repo. HACKATHON.md is the organizers' file at nearhackathon.com that the agent reads; the repo-side convention from 00-setup.md is instead: read HACKATHON.md before coding, install the NEAR agent skills (npx skills add near/agent-skills; includes near-ai-cloud, which is the one relevant to SafeRedline), look up endpoints/SDK versions in rather than guessing, build on testnet first, keys in .env.
No HACKATHON.md or AGENTS.md is asked for inside your repo. HACKATHON.md is the organizers' file at nearhackathon.com that the agent reads; the repo-side convention from 00-setup.md is instead: read HACKATHON.md before coding, install the NEAR agent skills (npx skills add near/agent-skills; includes near-ai-cloud, which is the one relevant to SafeRedline), look up endpoints/SDK versions in 
https://docs.near.org/llms.txt
rather than guessing, build on testnet first, keys in .env.
(c) DRAFT X POST (277 characters, tags as you specified; attach the demo video or screenshots when posting)
An NDA is the one document you can't paste into a chatbot. SafeRedline reviews contracts inside a NEAR AI Cloud TEE: attestation verified per request, every answer signed by the enclave, nothing stored. Built at NEAR HACKATHON @buidlcity @NEARProtocol @nearlegion #NEARHackathon
(d) DRAFT "WHAT DID YOU BUILD?" ANSWER (1,386 characters, within the 20-2000 limit)
Contracts and NDAs are exactly the documents you cannot paste into a normal AI chatbot: they are confidential, often under NDA themselves, and a regular LLM API gives you no proof of where your text went or whether it was kept.
SafeRedline is a contract and NDA reviewer built for that problem. You open a document in the browser, and the review (risky clauses, one-sided terms, missing protections, plain-English explanations, suggested redlines) is produced by an LLM running inside a NEAR AI Cloud confidential VM: Intel TDX plus NVIDIA GPU confidential computing. Nothing is stored server-side.
What makes it verifiable rather than a promise: for every request the client fetches the enclave's attestation evidence bound to a fresh nonce, so a replayed or stale attestation fails; and every response carries the enclave's ECDSA signature, which the client checks before rendering, so an answer that did not come from the attested enclave is rejected. A verification panel shows each check passing or failing in real time. If verification fails, the document is never sent.
NEAR is the load-bearing piece: NEAR AI Cloud is what puts the model inside the TEE and makes the attestation and signing keys available to verify against. Without it this would be an ordinary chatbot with a privacy policy. With it, privacy is a property the user can check, not a claim they have to trust.
