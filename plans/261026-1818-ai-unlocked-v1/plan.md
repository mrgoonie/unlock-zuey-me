# AI Unlocked v1 — plan

Status: in progress · Issue: mrgoonie/unlock-zuey-me#1 · zuey-me identity: mrgoonie/zuey-me#381 / PR #382

## Done means (contract, from the confirmed brief)
1. https://unlock.zuey.me 200, deployed by GitHub Actions from main.
2. Guest completes plan-weekend on a phone viewport (evidence → per-criterion score → XP/badge); Playwright e2e passes against production.
3. Sign in with zuey.me works in production; guest progress merges; zuey-me PR merged, CI green, deployed.
4. 8 missions + 3 labs (token, context, hallucination) + ~40-concept buzzword decoder; CI blocks invalid content.
5. Coach 4-level hints + practice chat via OpenRouter with daily caps, Workers AI fallback; AI errors never lose work.
6. XP only on passing evidence; badges, soft streak, recap, shareable certificate; SFX toggle; reduced motion & keyboard OK.
7. Installable PWA; push reminders at learner-chosen time via cron; can be turned off.
8. /mcp Streamable HTTP + OAuth: profile/missions, start_mission, submit_evidence visible on web; no-token and cross-user rejected (tested).
9. Admin observer dashboard (timeline/funnel/hints/scores/evidence) only with learner consent; revoking hides immediately. Export/delete data.
10. Unit + e2e green in CI; independent review clean; issue labels correct; no leftover processes/worktrees.

## Phases (parallel, disjoint file ownership)
| Phase | Owner files | Depends on |
|---|---|---|
| 0 Scaffold (done in main) | config, schema, migrations, layout, stubs, CI | — |
| A Content | `content/**` | 0 |
| B Labs | `src/components/labs/**`, `src/pages/labs/**`, `src/lib/labs/**` | 0 |
| C1 Engine + coach + API | `src/lib/learning/**`, `src/lib/coach/**`, `src/lib/db/**`, `src/pages/api/v1/**` (except push/admin/me) | 0 |
| C2 Learner UI | `src/components/{mission,home,progress,ui}/**`, learner pages | 0 (API contract in `src/lib/learning/types.ts`) |
| D Identity + MCP | `src/lib/identity/**`, `src/lib/mcp/**`, `src/middleware.ts`, `src/worker.ts`, `src/pages/auth/**`, `src/pages/oauth/**`, `public/oauth/**` | 0, zuey-me PR |
| E PWA + push + observer + data rights | `src/lib/push/**`, `src/lib/observer/**`, `public/sw.js`, `public/manifest.webmanifest`, `src/pages/api/v1/{push,admin,me}/**`, `src/pages/admin/**`, `src/pages/settings.astro`, `src/components/admin/**` | 0 |
| F Integration + e2e + review | `tests/e2e/**`, fixes | all |

## Risks
- MCP spec 2026-07-28 is new; serve dual-era (`legacy: 'stateless'`).
- Vietnamese quality of models unbenchmarked; static hints are the floor.
- iOS push needs 16.4+ and Add to Home Screen.
