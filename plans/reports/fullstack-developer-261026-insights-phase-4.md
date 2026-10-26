# Phase 4 report: learner and operator insight dashboards, settings UI (#25)

Status: completed. Branch `feat/25-insights-phase-4`, merged with `origin/main` after phases 1 and 3 landed.

## What shipped

- Learner: `/insights` (timeline, filters for session/time/skill/mission, provenance line, queue state, "Hữu ích"/"Không hữu ích", delete with inline confirm, "Xoá tất cả báo cáo" behind typed XOA, fixed observable-only disclaimer). `/insights/pair` (guest sign-in CTA, editable code, device label/adapter via `peekPairing`, sent/never-sent lists, required analysis-consent checkbox, Đồng ý/Từ chối).
- Settings: "ai-tutor & báo cáo học" section rendered only when `insightsEnabledFor`; status chip, three consent toggles (aggregate k≥3 disclosure in the analysis toggle copy), devices with revoke, links to `/skill` and `/insights`, export/delete note.
- Links: `/progress` header "🧭 Báo cáo ai-tutor" and `/admin` "Insights ai-tutor", both only when enabled. Existing selectors unchanged.
- Operator: `/admin/insights` (pipeline health today/7 days, learning patterns, product signals with link to `/admin/insights/proposals`, sharing learners) and `/admin/insights/learners/[id]` drill-down. All `noindex`, `no-store`.
- APIs: `GET /api/v1/insights/reports`, `DELETE /reports/:id`, `POST /reports/:id/feedback`, `POST /reports/delete-all`, `GET /api/v1/admin/insights/summary`, `GET /api/v1/admin/insights/learners/:id/reports`.
- Lib: `learner-report-queries.ts` (also exports `toReportView`, shared with the drill-down), `operator-insight-queries.ts`, `operator-access-audit.ts`.

## Privacy decisions as implemented

- Every learner statement is `WHERE learner_id = ?` from the session; other learners' ids return 404. Expired reports are invisible. `product_observation` is never returned.
- Aggregates are counts only over `analysis=1` learners, each bucket `HAVING COUNT(DISTINCT learner_id) >= 3`. Signals count only evidence from `proposals=1` learners, k ≥ 3, and show only the signal title.
- Drill-down gate is in SQL: `observer_consent=1 AND share_operator=1 AND analysis=1`, member, not deleted or merged. Gate failure → 404 with no audit row. Each successful view writes one `insight_access_audit` row (`view_reports`) before data is returned; an audit failure fails the request.
- No operator module references the queued turn payload column (test greps the files).

## Tests

- `tests/unit/insights-learner-reports-api.test.ts` (13): list/filter/paginate/400s, cross-user 404, feedback, delete, delete-all also removes pending and processing events, flag modes, guest, 401.
- `tests/unit/insights-operator-access.test.ts` (9): admin/flag 404s, both one-sided consents, analysis=0, unknown id, audit rows, revoke → next call 404 with no audit, observer revoke via existing route, deleted learner, payload grep.
- `tests/unit/insights-operator-access-aggregates.test.ts` (7): cohort 3 shown, cohort 2 suppressed, corrupt JSON row tolerated, proposals=0 excluded from signals, proposal status, health windows (Asia/Saigon day), no PII in aggregates.
- `tests/unit/insights-dashboard-gating-and-copy.test.ts` (11): flag gate, structural page gating (no Astro container in the vitest config), disclaimer and forbidden-claim lint, island helpers.
- `bun run test` 668/668, `content:check`, `migrations:check`, `bun run build` (0 errors) pass. The timing test `insights-redaction` (phase 0) failed once under full-suite load before the merge and passed alone and after the merge.
- Manual QA: local `wrangler dev` with `INSIGHTS_MODE=internal`, a seeded admin session and reports (local persisted state in the session scratchpad, nothing remote). Checked 360 px and 1280 px for all pages, keyboard rating (aria-pressed), filter, the 404 drill-down for an unknown id, and the guest view of Settings without the section. A visible pressed style was added after QA.

## Deviations

- The aggregates test file is named `insights-operator-access-aggregates.test.ts` (not `insights-operator-aggregates.test.ts` from the plan) to stay inside the assigned `insights-operator-access*` ownership pattern.
- "Budget deferrals" in pipeline health is the current count of pending turns with `attempts = 0` scheduled more than 6 minutes after arrival, because `deferWindow` leaves no persistent marker.
- Learning patterns use a 30-day window. The drill-down shows the 50 newest reports with no pagination.
- After the merge, the learner gate reuses `requireInsightsLearner` from `ingest-auth.ts` and the pair page uses `peekPairing`. The earlier local copies were removed.

## Cross-phase requests

- Phase 3: persist budget deferrals (for example a counter or a `deferred_at` column) if operators need an exact count rather than the current-queue estimate.
- Phase 6: add the reports and admin insights endpoints to `docs/api-contract.md`. The e2e can use `data-testid` `insight-report`, `insights-queue`, `insights-disclaimer`, `insights-settings`, `insights-status`, `pair-device`.
- `GET /api/v1/insights/settings` (phase 1) computes queue state inline. It duplicates `queueState` in `learner-report-queries.ts`, and a later cleanup could share it.

## Unresolved questions

- None blocking.
