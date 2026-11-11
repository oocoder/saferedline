# next.md: SafeRedline active work (delete at completion)

State at 2:55 PM ET 2026-11-11. Source of truth for any agent picking this up.

## Done
- App built, 155+ offline tests, E2E 30/30 (twin + live), 4 AI-judge rounds (last 9/10), gitleaks clean.
- Public repo: https://github.com/oocoder/saferedline. X post with video: https://x.com/AlexBuildsNY/status/2120597792963883456.
- Hackathon form SUBMITTED + VERIFIED (API 409). NEVER resubmit; use https://nearhackathon.com/request-changes.
- Vercel project linked: pensi-work/saferedline (`.vercel/` + `.env.local` gitignored). Sensitive env vars set (production + preview): NEAR_API_KEY, HOSTED_DEMO=1, TRUST_PROXY=1, NODEJS_HELPERS=0.

## In progress (uncommitted in working tree)
- Engineer A: Vercel adapter (createHandler refactor, api/index.mjs, vercel.json with security headers + maxDuration 120, .vercelignore, hosted timeouts, /api/attest limit + cache, HEAD only on / and /api/health, engines 22.x, x-vercel-forwarded-for).
- Engineer B: hosted-demo UI (blue samples-only banner, read-only input, 429/403 messages). Done, uncommitted.
- Engineer C: Vercel docs (README "Live demo", threat model). Needs a line-link resync after A (`npm run check:docs`).

## Deploy runbook (after A reports)
1. Gate: `npm test` (all green), `npm run check:docs` (0 problems), twin E2E (`PORT=3970 SAFEREDLINE_TWIN=1 node src/server.mjs` + `BASE_URL=http://127.0.0.1:3970 npm run e2e`), `gitleaks git . --config .gitleaks.toml`.
2. Confirm `.vercelignore` excludes `.env*` (except .env.example), .work, tests, docs. Commit + push (stage named files only; never `git add -A`).
3. `vercel deploy --prod --yes` → read the production alias → `printf %s <alias> | vercel env add ALLOWED_HOSTS production --force` → redeploy.
4. Smoke test (architect's list): health mode=hosted-demo; CSP/nosniff/no-store headers on `/`; `/.env`, `/package.json`, `/src/server.mjs` return 404; samples=3; /api/attest verified; analyze sample 0 verified + pinned + signed; non-sample → 403 SAMPLES_ONLY; text/plain → 415; bad Origin → 403; rate limit → 429; JSON 404.
5. Vercel Firewall: 1 rate-limit rule on POST /api/analyze (dashboard; the user may need to click).
6. Update README live URL (C), commit, push. pi-swarm judges against the live URL.

## Today (user)
- Demo sign-up (WhatsApp link, closes 4:00 PM). Rehearsal ~3:45 (`npm start` → localhost:3000, `docs/demo-script.md`). Demo 4:30 PM. Fallback: `npm run twin`.

## After the hackathon
- Rotate the NEAR AI key after 2026-11-18. Revoke the unused NEAR Builders "api…" key.
- Optional: Phala dstack TEE hosting (server attested). ICM batch workspace.
- Private briefing: ~/projects/saferedline-notes/briefing.md (outside the repo).
