# Phase 4: Learner and operator dashboards, settings UI

Effort 10h · Depends on: 0 (types, schema, flags); 1 (consent/settings/pair/token APIs) at integration; the report shape is fixed by phase 0 types · Parallel with: 1, 2, 3, 5 · Status: pending

## Context

Evidence:
- `/admin` pages answer 404 to non-admins and set `no-store` (`src/pages/admin/index.astro:8-21`).
- The observer consent gate is a SQL fragment evaluated inside every statement (`src/lib/observer/consent-gate.ts:8-12`), and observer queries are the single read path (`src/lib/observer/queries.ts:1-8`).
- The settings page composes React panels (`src/pages/settings.astro:57-65`, `src/components/settings/*`).
- The progress page header has an action link slot (`src/pages/progress.astro:20-23`).
- `requireLearner` / `requireObserverAdmin` live in `src/lib/privacy/learner-route-context.ts:17,26`.
- All learner-facing copy is Vietnamese (`docs/api-contract.md` conventions).

## Requirements

**Learner** (`/insights`, a separate tab reachable from `/progress` and Settings, not in BottomNav):
- A short timeline of reports. Each report shows: intent with confidence, what was tried (`workflow_observed`), verification gaps, progress points (`learning_insights`), and the next suggestion (linked to the mission).
- Filters: session, time range, skill (competency), mission.
- A provenance line on every report: "Nguồn: Claude Code · phân tích bởi ai-tutor (máy chủ) · dựa trên N lượt · mô hình …".
- Processing state: queued count and the time of the last received turn.
- Per-report actions: "Hữu ích" / "Không hữu ích" and Xoá. A "Xoá tất cả báo cáo" action with confirmation.
- A fixed disclaimer: "ai-tutor chỉ dựa trên những gì hiển thị trong phiên (lời nhắn của bạn, câu trả lời cuối, tên công cụ đã dùng). Nó không đọc được suy luận ẩn của mô hình AI."

**Settings** (`InsightsSettingsPanel`, rendered only when `insightsEnabledFor`):
- Status chip: `Đang thu thập` / `Đã tạm dừng` / `Chưa kết nối thiết bị`.
- Three separate toggles with explicit copy:
  1. "Cho ai-tutor phân tích phiên làm việc với AI để tạo báo cáo cho riêng bạn"
  2. "Cho phép người vận hành xem báo cáo chi tiết của bạn (cần bật thêm quyền quan sát)"
  3. "Cho phép dùng gợi ý đã ẩn danh để đề xuất cải thiện nền tảng"
- Connected devices with revoke, a link to `/skill`, and a link to `/insights`.
- A note that export and delete under "Dữ liệu của bạn" include insights.
- Turning off (1) shows "Đã dừng ngay. Thiết bị vẫn cài hook nhưng máy chủ sẽ từ chối mọi dữ liệu mới."

**Pairing page** `/insights/pair?code=XXXX-XXXX`:
- Guest → a sign-in CTA (`/auth/zuey/login?return_to=…`).
- Member → the code (prefilled and editable), the device label and adapter from KV, a plain list of what will be sent and what never will be, a required checkbox granting consent (1) if it is not already on, and Đồng ý / Từ chối buttons.

**Operator** (`/admin/insights`, admins only, 404 otherwise):
1. **Pipeline health** (today and 7 days), counts only: received, pending, processing, skipped by reason, dead, analysed, budget deferrals, useful-rate.
2. **Learning patterns**, aggregated from learners with `analysis=1` and suppressed below a cohort of 3 distinct learners (k-anonymity): skills needing reinforcement, verification-gap rate, risk-signal kinds, distribution of next-best-action missions, and task outcomes (reports with a linked `run_id` joined to `mission_runs.status`).
3. **Product signals:** category, area, title, occurrences, affected learners (only evidence from `proposals=1` learners, k ≥ 3), last seen, and proposal/issue status with a link to `/admin/insights/proposals` (phase 5 page).
4. **Learners sharing detail:** only `observer_consent=1 AND share_operator=1 AND analysis=1`.

**Operator drill-down** `/admin/insights/learners/[id]`:
- Reports only. Raw queue payloads are never selected by any operator query.
- Gated in SQL. An unknown id, a non-consenting learner, and a revoked learner are all 404.
- Each successful view writes `insight_access_audit` (`action:'view_reports'`).

## Files to create

| File | Responsibility |
|---|---|
| `src/lib/insights/learner-report-queries.ts` | `listReports(db, learnerId, {cursor, limit≤50, from, to, skill, missionId, sessionRef})` (keyset on `created_at,id`, `WHERE learner_id = ?` always), `listSessions`, `queueState`, `deleteReport(db, learnerId, id)` (scoped; 0 rows → 404), `deleteAllReports(db, learnerId)` (also deletes pending events), `setUseful(db, learnerId, id, useful)` |
| `src/lib/insights/operator-insight-queries.ts` | `insightDetailJoin(alias)` = `${consentJoin(alias)} JOIN insight_consents ic ON ic.learner_id = l.id AND ic.share_operator = 1 AND ic.analysis = 1` (reuses `consentJoin`), plus `pipelineHealth`, `learningPatterns` (with `HAVING COUNT(DISTINCT learner_id) >= 3`), `productSignals` (joins evidence → reports → `insight_consents.proposals=1`, cohort ≥ 3), `listSharingLearners`, `getLearnerReportsForOperator` (returns null when the gate fails) |
| `src/lib/insights/operator-access-audit.ts` | `recordInsightAccess(db, {learnerId, actorId, action, targetRef})`, called only after the gate passes |
| `src/pages/api/v1/insights/reports/index.ts` | `GET` list with filters, then `{reports, nextCursor, sessions, queue}` |
| `src/pages/api/v1/insights/reports/[id].ts` | `DELETE` |
| `src/pages/api/v1/insights/reports/[id]/feedback.ts` | `POST {useful:boolean}` |
| `src/pages/api/v1/insights/reports/delete-all.ts` | `POST {confirm:"XOA"}` (same confirm word as `/api/v1/me/delete`) |
| `src/pages/api/v1/admin/insights/summary.ts` | `GET` (admin) → health, patterns, signals, sharing learners |
| `src/pages/api/v1/admin/insights/learners/[id]/reports.ts` | `GET` (admin plus gate) with audit |
| `src/pages/insights.astro` | Learner page (feature-gated, `not_found` otherwise) |
| `src/pages/insights/pair.astro` | Pairing approval page |
| `src/pages/admin/insights/index.astro`, `src/pages/admin/insights/learners/[id].astro` | Operator pages (`noindex`, `no-store`) |
| `src/components/insights/InsightsTimeline.tsx`, `InsightReportCard.tsx`, `InsightFilters.tsx`, `insights-api.ts`, `PairApproval.tsx` | Learner UI (React islands, Tailwind, keyboard-accessible, reduced-motion safe) |
| `src/components/admin/insights/summary/PipelineHealth.astro`, `LearningPatterns.astro`, `ProductSignals.astro`, `SharingLearners.astro` | Operator summary |
| `src/components/admin/insights/drilldown/OperatorReportList.astro` | Drill-down list (Astro escapes all text, so no `set:html`) |
| `src/components/settings/InsightsSettingsPanel.tsx` | Settings panel calling the phase 1 APIs |
| Tests | `tests/unit/insights-learner-reports-api.test.ts`, `insights-operator-access.test.ts`, `insights-operator-aggregates.test.ts` |

## Files to modify

| File | Change |
|---|---|
| `src/pages/settings.astro` | Insert a `<section aria-labelledby="s-insights">` "ai-tutor & báo cáo học" after the privacy section (`:57-60`), only when `insightsEnabledFor(env, learner)` |
| `src/pages/progress.astro` | Add a header link `🧭 Báo cáo ai-tutor` → `/insights` next to Thành tích (`:22`) when enabled |
| `src/pages/admin/index.astro` | Add an "Insights" link when enabled for admins |

## API contracts (learner)

- `GET /api/v1/insights/reports?cursor=&limit=&from=&to=&skill=&mission=&session=` → `{ reports: InsightReportView[], nextCursor, sessions:[{ref, label:"Phiên 3 (26/10)", lastAt}], queue:{pending, lastReceivedAt} }`.
  `InsightReportView = { id, createdAt, sessionRef, missionId, intent:{text, confidence}, workflow:[{step, ref}], learning:[{skill, note}], gaps:[…], risks:[…], next:{text, missionId?}|null, confidence, provenance:{sourceRuntime, model, promptVersion, eventCount, windowStartedAt, windowEndedAt}, useful }`. `product_observation` is **not** shown to learners, because it is an operator pipeline input.
- `DELETE /api/v1/insights/reports/:id` → `{ok:true}`. Another learner's id → 404.
- `POST /api/v1/insights/reports/:id/feedback {useful}` → `{ok:true}`.
- `POST /api/v1/insights/reports/delete-all {confirm:"XOA"}` → `{deleted}`.
- Every route: feature off for the learner → 404. No learner → 401.

## Steps

1. Query modules and their SQL tests, including cross-user and gate tests.
2. API routes and their tests, calling the handlers directly through `routeContext()` (`tests/unit/observer-seed-fixtures.ts`).
3. React components and pages, then the settings, progress, and admin links.
4. Manual QA on local preview with `INSIGHTS_MODE=internal`, an admin member session, and seeded reports, at 360 px and desktop.

## Tests (must cover)

- **Cross-user:** learner B listing, deleting, or rating A's report → 404 / empty. Filters never widen the scope.
- **Operator gate:**
  - No admin → 404.
  - Admin + learner with `share_operator=1` but `observer_consent=0` → 404, and the reverse is also 404.
  - Both on → 200 with an audit row written.
  - Revoke `share_operator` → the very next call is 404 with no audit row.
  - `analysis=0` → 404.
- **Aggregates:** a cohort of 2 learners → suppressed. A cohort of 3 → shown. `proposals=0` learners excluded from signal counts. No aggregate response contains `learner_id`, `display_name`, `email`, or report text, except signal titles drawn from k ≥ 3 signals.
- **Raw transcript never exposed:** no operator query selects `insight_events.payload_json`. A test greps the SQL text of `operator-insight-queries.ts`.
- **Delete-all** also deletes pending events.
- **Flag off:** pages and routes → 404, and the settings section is absent from the rendered HTML (render via an Astro container, or assert the section's presence through `insightsEnabledFor` in a unit test).

## Success criteria

- A learner can view, filter, rate, and delete reports, and pause from Settings with immediate server effect.
- An operator sees health, patterns, and signals without personal data, and drill-down follows the double consent with an audit trail.
- Existing `observer-consent-gate.test.ts` and `api-v1-routes.test.ts` stay green.

## Risks

| Risk | L × I | Mitigation |
|---|---|---|
| Small cohort re-identifies a learner | M × M | k ≥ 3 suppression on every aggregate and signal; the drill-down list shows only learners who opted in |
| Operator page reads stale consent from a cache | L × H | No caching: gate joins sit in every statement, and `no-store` is set |
| `settings.astro` conflicts with other in-flight PRs | L × L | A single section insertion; rebase |

## Rollback

`INSIGHTS_MODE=off` hides every page, section, and link. Reverting the PR removes the UI without data impact.
