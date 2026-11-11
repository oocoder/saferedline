# Judge Q&A fact-check (gathered by Muse, Nov 11 2026, with source URLs; vendor telemetry is labeled as such)
(1) HARVEY AI PRICING: PARTLY ACCURATE, WITH ONE INVERSION TO FIX
Harvey publishes no pricing at all (harvey.ai/pricing returns 404; demo-and-quote only, annual enterprise contracts, no self-serve trial) —
https://www.aiinsiders.net/tools/reviews/harvey
Reported figures from buyer accounts: about $1,200/seat/month base, $2,400 with the LexisNexis integration, a reduced-scope tier near $399, with roughly 20-50 seat minimums on 12-month terms — 
https://www.eesel.ai/blog/harvey-ai-pricing
So "$1,000+/seat/month" is accurate for mid-market firms (reported band $1,000-$2,000), but at Am Law 100 scale (200+ seats) the reported per-seat price drops to roughly $100-$200 because of volume discounts —
https://thelegalprompts.com/blog/harvey-ai-pricing
In other words, do not pair "$1,000+/seat" with "AmLaw 100" as if the biggest firms pay the most per seat; they reportedly pay the least per seat. "AmLaw/large-firm focus, sales-led with pilots and procurement" is supported by the sales model above; a specific measured sales-cycle length is unverified.
(2) COPILOT / GEMINI TEE ATTESTATION: NO FOR BOTH SAAS PRODUCTS
Microsoft 365 Copilot: its protections are contractual, not attestable. Microsoft's own data/privacy page promises prompts, responses and Graph data are not used to train foundation models and are processed under the Microsoft 365 tenant boundary and DPA; it offers the customer no hardware attestation to fetch or verify, per request or otherwise — 
https://learn.microsoft.com/en-us/copilot/microsoft-365/microsoft-365-copilot-privacy
Gemini for Google Workspace: the same shape. Google's Workspace Privacy Hub commits that content is not used for training outside your domain, is not human reviewed, and stays within your organization — again contractual commitments, with no customer-verifiable TEE attestation for Workspace prompts —
https://knowledge.workspace.google.com/admin/generative-ai/generative-ai-in-google-workspace-privacy-hub
The distinction that makes this precise: both vendors sell attestation-capable confidential computing as a platform for workloads you deploy yourself (Azure Confidential VMs / Microsoft Azure Attestation; Google Confidential Space / Confidential Computing), and Google has announced "Private AI Compute" (Titanium Intelligence Enclaves with remote attestation) for consumer Gemini features on Pixel/Android — reported at 
https://creati.ai/ai-news/2026-02-01/google-launches-private-ai-compute/
 — but none of that is attached to the M365 Copilot or Gemini for Workspace SaaS products. A Copilot or Workspace customer cannot verify, for any given request, that it ran in a TEE. SafeRedline's per-request, client-verified attestation is a real differentiator against both.
(3) SELF-SERVE / SMB CONTRACT REVIEW TOOLS
Spellbook (Word add-in, drafting + review): no published pricing; sales-led, with third-party estimates around $99-$350/user/month (estimates, not a rate card) — 
https://gc.ai/blog/best-legal-ai-tools-for-in-house-counsel
. Retention: yes, an explicit zero-retention claim — Spellbook's own security page says it has negotiated zero data retention agreements with OpenAI and Anthropic, so request/response data "is not persisted and exists only in memory in order to process a request"; SOC 2 Type II; no TEE claim anywhere on that page —
https://www.spellbook.legal/security
LegalOn (playbook-based contract review): an Individual plan was published at $550/month billed annually as of June 2026, but LegalOn has since removed its public pricing page and gone quote-led — 
https://gc.ai/blog/best-legal-ai-tools-for-in-house-counsel
. Retention: reported to run on Azure OpenAI with zero data retention; SOC 2 Type II and ISO 27001; no TEE claim. (That retention detail comes from the GC AI comparison, a competitor's page, so treat it as reported rather than verified from LegalOn itself.)
GC AI (in-house counsel): published price $500/seat/month, no seat minimum, 14-day free trial, and "zero-data-retention with LLM providers wherever feasible" — 
https://gc.ai/blog/in-house-counsel-ai-software
. No TEE claim.
Juro, Ironclad and Robin AI published prices: unverified (I did not find a published rate card for them in this pass). Bottom line for Q and A: every tool above competes on contractual zero retention; none of the three claims TEEs or verifiable attestation.
(4) NEAR-AI-CLOUD SKILL: WHAT IT ADDS BEYOND YOUR LIST
Read: 
https://raw.githubusercontent.com/near/agent-skills/main/skills/near-ai-cloud/SKILL.md
 plus references/model-verification.md and references/gateway-verification.md in the same repo.
Verify the GATEWAY as a separate target: GET /v1/attestation/report without a model parameter returns gateway_attestation (its own intel_quote, event_log, compose info). Model attestation alone does not cover the gateway; conversely, requests to a model's direct completions endpoint skip the gateway and need only model verification.
TLS binding: request the gateway report with include_tls_fingerprint=true to bind the gateway's TLS certificate fingerprint into report_data, proving your HTTPS connection terminates inside the gateway TEE (TLS terminates inside the TEE, not at a load balancer; the flag is off by default for compatibility).
Per-GPU JWT checks beyond the overall result: x-nvidia-overall-att-result true is not sufficient; also check each per-GPU JWT for secboot: true, dbgstat: "disabled", measres: "success", all x-nvidia-*-verified fields true, x-nvidia-attestation-warning: null, the eat_nonce match on BOTH the overall and per-GPU JWTs, and the JWT exp (NRAS JWTs live roughly 1 hour; re-attest when expired).
Multiple serving nodes: model_attestations is a list because several TEE nodes may serve one model; the chat signer must match an attested signing_address from that set.
Source-code provenance: extract the nearaidev/cloud-api container image digests (@sha256:...) from the attested compose manifest and verify their Sigstore provenance; the cloud-api builds are reproducible, so a build from the release tag should reproduce the attested digest.
Signature retrieval details: chat signatures are persistent and queryable at any time after completion via GET /v1/signature/{chat_id} (also covers Responses API resp_* ids); signing_algo can be ed25519 as well as ecdsa.
Attestation endpoints now require an API key (Authorization: Bearer); retrieval is free and non-billable.
The skill also ships references your list doesn't mention: an end-to-end encrypted chat pattern (references/e2ee-chat.md) and a private-vs-anonymised models explainer (references/private-vs-anonymised.md).
One caution in the other direction: the skill files I read do not spell out an RTMR3 replay procedure. The gateway attestation includes a TDX event_log, and the compose check is specified as SHA-256 of the compose manifest compared against mr_config from the verified quote — cite it that way, not as "the skill prescribes RTMR3 replay" (unverified in the skill text).
(5) LEAK STAT
Cyberhaven Labs' 2025 AI Adoption & Risk Report: 34.8% of all corporate data employees input into AI tools is classified as sensitive, up from 27.4% a year earlier and 10.7% two years before that (telemetry across Cyberhaven's client base) — quoted at 
https://freedium-mirror.cfd/https://chierhu.medium.com/confidential-data-disclosed-to-and-through-large-language-models-083f380ec8ce
The older, widely cited Cyberhaven figure is that about 11% of the data employees pasted into ChatGPT was confidential (2023) —
https://intuitionlabs.ai/pdfs/chatgpt-data-security-preventing-proprietary-data-leaks.pdf
The Samsung incident behind the headlines: in 2023 Samsung engineers pasted proprietary source code and meeting notes into ChatGPT, after which Samsung banned generative AI use internally; reported widely, e.g.
https://www.zianetworks.net/blog/shadow-ai-at-work-is-your-team-pasting-client-data-into-chatgpt/
One honesty note for the judges: Cyberhaven is a security vendor selling data-loss prevention, so present its numbers as vendor telemetry, not peer-reviewed research.
