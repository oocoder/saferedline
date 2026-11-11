# next.md — SafeRedline hackathon build (active project; delete at completion)

Source of truth: [docs/plans/2026-11-11-architecture-plan.md](docs/plans/2026-11-11-architecture-plan.md) (sections 1-5).
Goal deadline: **16:15 ET** code freeze buffer (demo 16:30). Global submission: Nov 14 23:59 UTC.

## Phase A — parallel implementation (13:10 → 14:45)
| Eng | Owns (disjoint) | Done when |
|---|---|---|
| A backend/tests/twin | `src/**` `scripts/**` `tests/**` `samples/**` `package*.json` `.env.example` `.gitignore` | plan §5-A 1,4-8 green offline; `npm run twin` serves UI by 13:40 |
| B UI | `public/index.html` | plan §5-B 1-5 against `npm run twin` |
| C docs | `README.md` `LICENSE` `OUTLINE.md` `AGENTS.md` `CLAUDE.md` `docs/**` (not docs/plans) | plan §5-C 1-5; AGENTS.md ≤60 lines |

Engineering loop for every defect: reproduce in twin (red) → fix → green → one live confirm.

## Phase B — integration + live (14:45 → 15:30)
- [ ] Orchestrator: full `npm test` on quiet machine; `npm run twin` UI walk-through of all twin scripts.
- [ ] Live with real `sk-` key (user claims at nearbuilders.org/dashboard): `npm run verify`, non-ASCII sample, one UI analyze (plan §5-A 2-3).
- [ ] Adversarial review of attest.mjs fail-closed gates by independent subagent (Codex out of credits).

## Phase C — judge simulation + docs sync (15:30 → 16:15)
- [ ] pi-swarm read-only agent: fresh clone → follow README "do X, see Y" as an AI judge; report gaps.
- [ ] C updates README line links to final code; OUTLINE.md status.
- [ ] Commit (staged files only), tag `demo-2026-11-11`.

## After demo (by Nov 14)
- [ ] User: public GitHub repo, X post (draft in docs/submission-kit.md), form at nearhackathon.com/#apply.
- [ ] Hosted demo required for judges (Q-012), up until ≥ Nov 18 — stretch: run SafeRedline itself in a TEE (dstack CVM) to close the "server sees plaintext" gap.
- [ ] Stretch: ICM `workspace/` for batch contract review; TLS fingerprint binding (plan #25).
