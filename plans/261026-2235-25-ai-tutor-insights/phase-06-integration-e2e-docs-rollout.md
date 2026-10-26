# Phase 6: Integration, end-to-end checks, docs, rollout

Effort 5h · Depends on: 1, 2, 3, 4, 5 merged into the feature branch · Status: pending

## Context

The production Playwright suite targets the deployed site with guest learners (`playwright.config.ts:7`; specs in `e2e/`). Insights flows need a zuey.me **member** session, which production e2e cannot automate. Member flows are therefore covered by route-level integration tests plus a scripted manual QA pass on local preview. Playwright covers the flag-off guarantees and the public `/skill` behaviour. CI runs `content:check`, `test`, and `build` (`.github/workflows/ci.yml`).

## Requirements

- One integration test drives the whole chain in-process: spool payload from `turn-payload.mjs` → `POST /api/ingest/v1/turns` handler → analyzer stage (mock AI) → learner reports API → proposal stage (mock AI, GitHub off) → operator summary.
- A regression test proves that the flag off means no behaviour change.
- Docs: the API contract, README, and ingest contract finalised.
- Rollout checklist and evaluation gate for enabling GitHub issues.

## Files to create / modify

| File | Change |
|---|---|
| `tests/unit/insights-end-to-end-pipeline.test.ts` | Full chain with three learners (two with `proposals=1`, one without) and redaction assertions at every hop. Revoke mid-chain → no report. Duplicate POST → one event. |
| `tests/unit/insights-feature-off-regression.test.ts` | `INSIGHTS_MODE` unset: every insights and ingest route and every `/skill/*` route → 404; `runInsightsPipeline` → `{skipped:'flag_off'}` with 0 subrequests charged; `MCP_SCOPES` deep-equals `['learn:read','learn:write']`; `/api/v1/admin/learners/:id` detail keys unchanged (snapshot of the key set); `learnerPolicy('/api/ingest/v1/turns', …)` is the only policy change |
| `e2e/insights.spec.ts` | Against `E2E_BASE_URL`: with the flag off (production today), `/skill` → 404, `/insights` → 404, and the Settings HTML has no `s-insights` section. With `E2E_INSIGHTS=1` (local preview with `INSIGHTS_MODE=on`), a guest sees the sign-in CTA on `/insights/pair` and `/skill` serves a manifest whose file hashes verify. |
| `docs/api-contract.md` | New sections: "Insights (learner)", "Ingest (device token)", "Admin insights", the error `reason`s, and that `/api/ingest/**` is outside the cookie session and same-origin rules |
| `docs/insights-ingest-contract.md` | Finalise from the implemented behaviour (phase 0 draft) |
| `README.md` | Structure table row `src/lib/insights/` and `skills/ai-unlocked/`; secrets `GITHUB_ISSUES_TOKEN` (optional); vars `INSIGHTS_*`; a link to `/skill` |

## Manual QA script (local preview, real member account)

1. `bun run db:migrate:local`, set `INSIGHTS_MODE=internal` in `.dev.vars`, run `bun run build && bun run preview`, and sign in as an admin member.
2. In a scratch project, Claude Code runs `curl -fsSL http://localhost:8787/skill/install.mjs | node - --scope project`, then `hook install --scope project`. Diff `.claude/settings.local.json` before and after.
3. Run `pair`, approve on `/insights/pair`, run 3 learning turns using the MCP tools, then trigger the cron (`wrangler dev --test-scheduled`, `curl /__scheduled`). The report appears on `/insights`.
4. Turn off analysis in Settings, run another turn, and check that no new event row exists (`wrangler d1 execute --local`) and that `doctor` shows "máy chủ từ chối: chưa đồng ý".
5. Run `uninstall --purge`. The settings file is byte-identical to the original, and the token is revoked in Settings.
6. Measure hook overhead with `time` on 20 turns and record it in the PR description.

## Rollout checklist

1. Merge with `INSIGHTS_MODE=off`. The deploy applies migration 0008 (additive; safe under #18). Smoke `/api/health`.
2. Switch to `internal` (admins) for one week. Watch pipeline health, dead-letter count (target 0), useful-rate (target ≥ 60%), and AI spend (`ai_usage` coaching share).
3. Switch to `pilot` with `INSIGHTS_PILOT_EMAILS`, which requires explicit opt-in.
4. Enable GitHub issues only after ≥ 20 operator-reviewed proposals with < 10% judged "not a general platform issue". First `issues`, then `issues_ai_handle` with `safe_auto_implement` on.
5. Switch to `on`.

## Success criteria

- CI green, the feature-off regression green, the e2e flag-off checks green against production after deploy.
- Code review (high-risk change: privacy and consent, new auth surface) passes before merge to `main` via PR.
- Docs updated and links verified.

## Risks

| Risk | L × I | Mitigation |
|---|---|---|
| Member flows not covered by automated e2e | M × M | Route-level integration tests plus the documented manual QA script, recorded in the PR |
| Conflicts with in-flight PRs (#17, #18, #23, #24) | M × L | Phase 0 touches the shared files minimally; rebase before phase 6 |

## Rollback

Flags as in the plan. Revert the PR range if needed. Migration 0008 stays, inert.

## Implementation notes (2026-10-26)

- Done: `tests/unit/insights-end-to-end-pipeline.test.ts`, `tests/unit/insights-feature-off-regression.test.ts`, `e2e/insights.spec.ts`, `docs/api-contract.md`, `docs/insights-ingest-contract.md`, `README.md`.
- The rollout checklist, evaluation gate, rollback and manual QA script live in the new `docs/insights-rollout.md` (linked from README and both contract docs) instead of `docs/deployment.md`, which stays about deploys and migrations.
- Production answers a session-less `/api/v1/**` request 401 in the middleware, nonexistent paths included; the e2e asserts the insights APIs answer exactly like a nonexistent path there, and 404 for a browser (guest) session.
- Manual QA: only the parts without a member account were run (installer round-trip in a temp HOME against a local preview, ingest auth probes, E2E_INSIGHTS=1). Pairing, live turns, cron and hook timing in a real Claude Code session remain for a person. Report: `plans/reports/fullstack-developer-261026-insights-phase-6.md`.
