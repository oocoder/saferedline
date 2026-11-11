# Build Specification: SafeRedline / VaultNDA (Zero-Leak Contract & NDA Reviewer)

**Event:** Build City × NEAR Legion: Private AI Hackathon NYC  
**Track:** `03. Privacy & Private AI` (`id: privacy`)  
**Target Demo Deadline:** Today, November 11, 2026 @ 4:30 PM ET  
**Recommended Repo Names:** `safe-redline`, `vault-nda`, or `zero-leak-nda`

---

## 1. Pitch & Positioning (Hackpack + *Personal MBA* Framework)

### Executive One-Liner (*Personal MBA* Outcome-Focused)
> *"Review confidential contracts in seconds without exposing your trade secrets to AI models or third-party servers."*

### Under-20-Word Pitch Options (Hackpack Step 2 Formula)
* **Option A — Startup & Founder Focus (18 words):**  
  > *"For **startup founders**, **SafeRedline** flags predatory contract clauses, needing private AI because **unredacted deals cannot leak**."*
* **Option B — Legal & Compliance Focus (19 words):**  
  > *"For **legal teams**, **VaultNDA** reviews confidential contracts, needing private AI because **client privilege requires zero data retention**."*
* **Option C — Short & Punchy (16 words):**  
  > *"For **deal-makers**, **SafeRedline** redlines risky contracts, needing private AI because **confidential terms stay strictly private**."*

### Competitive Differentiation (Judge Q&A Ready)
* **Why not Microsoft Word / Google Docs?** Word and Docs are formatting tools for manual Track Changes—they do not act as a private legal analyst that spots hidden traps, flags missing protections, and drafts replacement language.
* **Why not Microsoft Copilot / Google Gemini?** Standard cloud assistants rely on corporate Terms of Service and cloud admin trust. SafeRedline provides **cryptographic hardware attestation** (NVIDIA/Intel TEEs) proving zero server-side data retention.
* **Why not Harvey AI?** Harvey targets AmLaw 100 enterprise firms at **$1,000+/seat/month** with long sales cycles and relies on standard cloud compliance policies. SafeRedline serves **startups, SMBs, and boutique firms** with instant self-serve access (**$49–$199/mo**) and hardware-enforced privacy.

### Hackpack Step 3: Peer Feedback Tracker
*Use this quick table before 1:00 PM if testing your pitch or recruiting a teammate:*
| Name | What They Said (Clarity / Would Use?) | Join Team? | Contact (WhatsApp / X) |
| :--- | :--- | :--- | :--- |
| | | [ ] Yes [ ] Maybe | |
| | | [ ] Yes [ ] Maybe | |
| | | [ ] Yes [ ] Maybe | |

---

## 2. Core Hackathon Requirements (`03-privacy.md`)

To satisfy all track criteria and maximize judging points, the application **must**:
1. **NEAR AI Cloud Integration:** Call NEAR AI Cloud via its OpenAI-compatible API (`base_url="https://cloud-api.near.ai/v1"`, `NEAR_API_KEY` stored in `.env`) using a **TEE-hosted open-weight model** fetched from the `/v1/models` endpoint.
2. **Cryptographic TEE Verification:** Generate a fresh random cryptographic **nonce** per request, fetch the TEE attestation report from NEAR AI Cloud, verify the hardware signature/measurements per the NEAR AI Cloud verification docs, and display a **"Verified TEE Execution" panel** in the UI listing every check passed.
3. **Zero Server-Side Data Retention:** Hold uploaded contracts and AI outputs strictly in volatile memory for the duration of the HTTP request. Persist **nothing** to disk, databases, or server logs. Document this explicitly in `README.md` and code comments.
4. **Fictional Sample Documents:** Bundle 2+ realistic, fictional contracts directly in the app so judges can test the workflow with one click without uploading real confidential files.

---

## 3. Phased Build Plan (4:30 PM Showcase Schedule)

### Phase 1: Standalone TEE Attestation Script (12:15 PM – 1:00 PM)
*Goal: Prove end-to-end private inference and cryptographic verification before building any UI.*
1. Initialize repo (`safe-redline` or `vault-nda`) and configure `.env` with `NEAR_API_KEY`.
2. Query `GET https://cloud-api.near.ai/v1/models` to select an active TEE-hosted open-weight model (e.g., Qwen, DeepSeek, or Llama TEE models).
3. Write a minimal verification script (`verify_tee.py` or `verify_tee.ts`) that:
   - Generates a fresh 32-byte hex random `nonce`.
   - Sends a test completion request to `https://cloud-api.near.ai/v1/chat/completions`.
   - Fetches the attestation report for the model/enclave using the fresh `nonce`.
   - Validates the attestation signature, nonce match, and enclave measurement.
   - Prints a structured verification summary (`Verified: True`, nonce, model ID, enclave hash).

### Phase 2: Stateless Backend & Split-Screen UI (1:30 PM – 3:30 PM)
*Goal: Build a fast, clean web interface (Next.js or Streamlit) with zero persistence.*
1. **Left Panel — Contract Input & Redline Output:**
   - Text area to paste contract text or upload `.txt`/`.pdf` (parsed strictly in RAM).
   - Quick-load buttons: **"Load Sample Predatory SaaS NDA"** and **"Load Sample Balanced Mutual NDA"**.
   - Structured output cards displaying:
     - **Overall Risk Score** (Low / Medium / High)
     - **Flagged Clauses** (Exact quote, plain-English risk explanation, and copy-pasteable redline replacement text)
     - **Missing Standard Protections** (e.g., mutual confidentiality, residuals clause, return/destruction of data)
   - *(Optional Stretch Goal if finished before 3:30 PM)*: Add a stateless **"Ask a Follow-Up Question"** box that passes the in-memory contract text + user question to the TEE.
2. **Right Panel — Cryptographic "Verified TEE" Trust Panel:**
   - Green status badge: **Hardware TEE Verified — Zero Data Retention**.
   - Display exact verification telemetry: Fresh Request Nonce, TEE Model ID, Enclave Measurement Hash, Hardware Root of Trust (NVIDIA/Intel), and Signature Verification Timestamp.
   - Explicit indicator: *"0 bytes written to disk. Memory wiped upon response."*

### Phase 3: Demo Polish & README Documentation (3:30 PM – 4:15 PM)
1. Write a crisp `README.md` featuring the *Personal MBA* one-liner, setup instructions, architecture diagram, and a dedicated **Zero-Retention & Cryptographic Verification** section pointing to exact lines in the codebase.
2. Rehearse a 2-minute live demo flow: Click **Load Sample Predatory NDA** -> Click **Analyze Privately** -> Walk judges through the flagged IP grab clause -> Point to the **Verified TEE Panel** showing the fresh nonce verification.

---

## 4. System Prompt for Private Contract Analysis

Use this system prompt in your `/v1/chat/completions` call to enforce structured JSON output:

```text
You are SafeRedline, a meticulous corporate and commercial contracts analyst running inside a hardware-isolated Trusted Execution Environment (TEE). 

Analyze the user's contract text and identify predatory, one-sided, or risky clauses, as well as missing standard protections. Return ONLY valid JSON matching this exact schema:

{
  "overall_risk": "High | Medium | Low",
  "executive_summary": "2-sentence plain-English summary of the contract and its biggest risks.",
  "flagged_clauses": [
    {
      "clause_title": "Section name or topic",
      "risk_level": "High | Medium",
      "original_text": "Exact verbatim quote from the contract",
      "why_its_risky": "Clear explanation of the business or legal trap",
      "suggested_redline": "Balanced, copy-pasteable replacement wording"
    }
  ],
  "missing_protections": [
    "Short bullet describing a standard protection missing from this agreement"
  ]
}
```

---

## 5. Fictional Sample Documents (Bundle in App)

### Sample 1: `sample_predatory_nda.txt` (High Risk — Best for Live Demo)
```text
MUTUAL NON-DISCLOSURE AND EVALUATION AGREEMENT

This Agreement is entered into as of November 11, 2026, by and between Apex Global Holdings Inc. ("Company") and Counterparty ("Recipient").

1. Confidential Information. "Confidential Information" means any information disclosed by Company to Recipient. Information disclosed by Recipient to Company shall NOT be deemed Confidential Information unless expressly agreed in an amendment signed by Company's CEO.

2. Perpetual Term. Recipient's obligations of confidentiality under this Agreement shall survive in perpetuity, including with respect to information that becomes publicly known through no fault of Recipient.

3. Feedback & IP Assignment. Any ideas, suggestions, feedback, or derivative concepts shared by Recipient during discussions shall automatically become the sole and exclusive property of Company, and Recipient hereby irrevocably assigns all right, title, and interest therein to Company without compensation.

4. Uncapped Indemnification. Recipient shall indemnify, defend, and hold harmless Company against any and all claims, damages, losses, and attorney fees arising out of or relating to this Agreement, with no cap on liability.

5. Governing Law & Venue. This Agreement shall be governed by the laws of the Cayman Islands, and any disputes shall be resolved exclusively in courts located in George Town, Cayman Islands.
```

### Sample 2: `sample_balanced_nda.txt` (Low Risk — Baseline Comparison)
```text
STANDARD MUTUAL NON-DISCLOSURE AGREEMENT

This Mutual Non-Disclosure Agreement ("Agreement") is entered into on November 11, 2026, between Vanguard Labs LLC and Horizon Partners Inc. (each a "Party").

1. Purpose. The Parties wish to explore a potential business partnership ("Purpose").

2. Definition of Confidential Information. "Confidential Information" means non-public technical or business information disclosed by either Party in writing marked "Confidential" or, if disclosed orally, summarized in writing within fifteen (15) days.

3. Exclusions. Confidential Information excludes information that: (a) is or becomes publicly available without breach; (b) was known prior to disclosure; (c) is independently developed without use of Confidential Information; or (d) is rightfully received from a third party.

4. Term & Survival. This Agreement expires one (1) year from the Effective Date. Confidentiality obligations survive for three (3) years following termination.

5. Return or Destruction. Upon written request, the receiving Party will promptly return or certify destruction of all Confidential Information.

6. Governing Law. This Agreement is governed by the laws of the State of Delaware, without regard to conflict of law principles.
```
