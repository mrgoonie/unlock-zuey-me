# API contract (v1)

Shared contract between the learner UI, the learning engine, identity, MCP and observer modules. Types live in `src/lib/learning/types.ts`. Helpers: `src/lib/http/api-response.ts` (JSON + error shape), `src/lib/db/ids.ts`, `src/lib/observer/events.ts`.

## Conventions

- JSON in and out. Errors are `{ "error": { "code", "message" } }`. Codes: `unauthorized` 401, `forbidden` 403, `answer_locked` 403 (only for a write that changes a revealed answer, see `reveal` below), `not_found` 404, `conflict` 409, `invalid` 400, `rate_limited` / `budget_exceeded` 429, `unavailable` 503, `internal` 500.
- Throttles (`src/lib/identity/request-rate-limits.ts`, Workers Rate Limiting bindings in `wrangler.jsonc`): new guests per IP; `coach/chat`, `runs/:id/hints`, `runs/:id/submit`, `evidence/upload` per IP; `events`, `labs/:id/result`, `missions/:id/start`, `push/subscribe` per IP and per learner; `runs/:id/abandon` per learner (checked in the route). Over the limit → `rate_limited` 429. AI budgets (per learner and global USD for OpenRouter, per learner and global daily request caps for Workers AI) live in `src/lib/coach/ai-usage.ts`.
- Learner identity comes from `Astro.locals.learner` (`LearnerContext`). The middleware (identity module) guarantees it is set for `/api/v1/**` and every learner page by creating a guest learner + cookie session on first visit. It is **not** created for `/`, `/api/health`, `/certificates/*`, `/oauth/*`, `/mcp`, `/api/ingest/**` (device-token endpoints, see Ingest below), static assets.
- State-changing requests (`POST/PATCH/PUT/DELETE` under `/api/v1`) must be same-origin; the middleware rejects a foreign `Origin` with 403.
- Every query is scoped to `locals.learner.id`. Accessing another learner's run returns `not_found` (never leak existence).
- Messages shown to learners are Vietnamese.

## Learning engine (owner: engine module)

| Method & path | Body | Response |
|---|---|---|
| `GET /api/v1/me` | – | `{ learner: LearnerContext, progress: ProgressSummary }` |
| `PATCH /api/v1/me/profile` | `{ profile?: Partial<LearnerProfile>, displayName?: string }` | `{ learner }` |
| `GET /api/v1/missions` | – | `{ missions: MissionListItem[] }` |
| `POST /api/v1/missions/:id/start` | `{ again?: boolean }` (body optional) | `{ run: MissionRun }`: the open run, else the latest completed run (result, read-only), else a new run. `again: true` starts a new run of a completed mission ("Làm lại") |
| `GET /api/v1/runs/:id` | – | `{ run, mission: LearnerMission, evaluation: Evaluation \| null, answerKey: AnswerKey }` |
| `PATCH /api/v1/runs/:id/answers` | `{ stepId, answers, currentStep?, rev }` | `{ run }`; `409 conflict` with `{ error, run }` when `rev` is stale |
| `POST /api/v1/runs/:id/hints` | `{ stepId, level: 1..4 }` | `HintResult`; charged once per (run, step, level): a retry returns the stored hint (the authored static hint while the first request is still generating or when the AI fails). Worst case ~45 s; the browser waits 55 s |
| `POST /api/v1/runs/:id/reveal` | `{ stepId, itemId }` (quiz question id, or `prediction`) | `{ run, key: AnswerKeyEntry }`; the answer must be saved first and is locked afterwards: `PATCH …/answers` or submit changing it gets `403 { error: { code: "answer_locked", message }, run }` with the current run. The browser restores locked fields only on exactly this code with a valid `run`; any other 403 (generic `forbidden`, non-JSON from the edge) keeps every local edit and is reported as an unsaved save (`src/lib/ui/autosave-queue.ts`). MCP tools report the same refusal as `forbidden`. If the server still refuses a step after the client restored the locked fields it knows of (client and server disagree on what is locked), the runner keeps the edits and offers "Tải lại bước này từ máy chủ": reload the run, drop that step's unsaved edits only, save the other steps |
| `POST /api/v1/runs/:id/abandon` | – | `{ run }` with status `abandoned` ("Bỏ lượt này"). Frees the one-open-run slot, so the next `POST /missions/:id/start { again: true }` creates a fresh run. Idempotent on an abandoned run; `409 conflict` for a completed run or one still being graded (a crashed evaluation, shown as `evaluation_failed`, can be abandoned). No XP, evaluation or other side effect; emits `mission.abandoned`. The browser then drops that run's local draft |
| `POST /api/v1/runs/:id/submit` | `{ idempotencyKey, confidence?: 0..100, imageKeys?: string[] }` | `SubmitResult & { answerKey }` |
| `POST /api/v1/evidence/upload` | multipart `file` (image ≤ 5 MB) | `{ key }` |
| `GET /api/v1/evidence/:key` | – | image bytes (owner, or admin observer with consent) |
| `POST /api/v1/coach/chat` | `{ runId?, stepId?, messages: [{role, content}] }` (1–20 messages; `assistant` turns are kept only if they match a reply the server stored for this learner in the last 24 h) | `{ reply, model, remainingToday }` |
| `POST /api/v1/labs/:id/result` | `{ result: object }` | `{ labsDone: string[], newBadges }` (labs never grant XP) |
| `POST /api/v1/concepts/:id/view` | – | `{ ok: true }` |
| `GET /api/v1/recap?period=week` | – | `{ period, missionsCompleted, xpGained, competencyDeltas, highlights: string[], reflections: string[] }` |
| `POST /api/v1/certificates` | `{ displayName }` | `{ code, url }` (`403 forbidden` if not eligible; only the first passing evaluation per mission counts toward the verify ≥ 80% condition) |
| `POST /api/v1/events` | `{ name, missionId?, runId?, props? }` (allow-listed client events only) | `{ ok: true }` |

Answer keys: the browser only gets `LearnerMission` (`src/lib/learning/learner-mission-view.ts`), which has no claim verdicts, quiz/prediction answers, explanations, static hints or rubric checks. `answerKey` (`"stepId:itemId"` → `{ correct, explanation }`) holds only items revealed on the server, or every item once the run is `completed`.

Runs: at most one open run per learner and mission (partial unique index). `scripts/validate-content.ts` fails a mission whose quiz/prediction criteria (answers lockable by a reveal) weigh so much that a run with every revealed answer wrong could never reach `pass_score`. Evidence image keys stay readable and re-submittable by the member a guest uploader was merged into; admin reads follow that member's consent.

Rewards rules: XP only from a **passed** evaluation, once per learner per mission (`xp_ledger` ref = mission id; later passing runs earn 0 XP). Badges from `content/badges.yaml`. Soft streak counts active days and tolerates 1 rest day per 7.

## Identity (owner: identity module)

| Path | Purpose |
|---|---|
| `GET /auth/zuey/login?return_to=` | Starts Sign in with zuey.me (PKCE, CIMD client `https://unlock.zuey.me/oauth/zuey-client.json`, scopes `openid profile email`) |
| `GET /auth/zuey/callback` | Exchanges code, calls zuey.me `/oauth/userinfo`, upserts member, merges current guest progress, rotates session |
| `POST /auth/logout` | Ends the session (a new guest is created on next visit) |
| `GET /oauth/zuey-client.json` | CIMD client metadata document |

## MCP (owner: MCP module)

`/mcp` Streamable HTTP behind `@cloudflare/workers-oauth-provider` (`/authorize`, `/oauth/token`, `/oauth/register`, PRM at `/.well-known/oauth-protected-resource/mcp`). Tools call `src/lib/learning/service.ts` with the learner bound to the token: `get_profile`, `list_missions`, `get_mission`, `start_mission`, `get_run`, `submit_evidence`, `get_hint`, `abandon_mission` (learn:write; same rules as `POST /runs/:id/abandon`).

## PWA, push, observer, data rights (owner: platform module)

| Method & path | Purpose |
|---|---|
| `POST /api/v1/push/subscribe` | `{ subscription, remindTime: "HH:MM", timezone }` → `{ status }`. Endpoint must be a known push service (FCM, Mozilla, Apple, WNS) |
| `POST /api/v1/push/unsubscribe` | `{ endpoint }` → `{ status }` (idempotent) |
| `GET /api/v1/push/settings` | `{ status: { devices, enabled, remindTime, timezone, lastSentDay } }` |
| `PATCH /api/v1/push/settings` | `{ remindTime?, enabled? }` → `{ status }` (all of the learner's devices; 404 if none) |
| `GET /api/v1/push/public-key` | `{ key }` (VAPID public key; 503 when not configured) |
| `POST /api/v1/push/opened` | `{ tag?, url? }` sent by `public/sw.js` on notification click → `push.opened` event |
| `PATCH /api/v1/me/consent` | `{ observer: boolean }` → `{ observerConsent }` (emits `consent.granted` / `consent.revoked` on change) |
| `GET /api/v1/me/export` | JSON download of all the learner's data, incl. tables owned through their runs such as `run_hints` (credentials such as token hashes and push keys omitted). Bounded per table and in total; tables cut off are listed in `continuation` with a `?table=<name>&after=<n>` URL returning the next page (`{ rows, next }`) |
| `POST /api/v1/me/delete` | `{ confirm: "XOA" }` deletes the learner's rows (incl. merged guests) and R2 `ev/<learnerId>/*`, expires cookies; idempotent |
| `GET /api/v1/admin/learners` | admin only; learners with consent |
| `GET /api/v1/admin/learners/:id` | admin only; timeline (first page), funnel, hints, scores, calibration, competencies, first win, evidence, coach chats (consent required, checked per request) |
| `GET /api/v1/admin/learners/:id/events?cursor=&limit=` | admin only; older timeline pages `{ events, nextCursor }` |

Non-admins get `404 not_found` from every admin route and page (never 403). A learner without `observer_consent = 1` is `not_found` for admins too. Evidence images on `/admin` load from `GET /api/v1/evidence/<key>` with each `/`-separated key segment URL-encoded.

Push reminder cron (`src/lib/push/reminder-job.ts`): every 15 minutes, sends at most one reminder per subscription per local day when `remind_time` is in the current local quarter hour (or up to 60 minutes earlier that day, to catch up a run that hit its budget) and the learner has no `activity_days` row for that day. Due subscriptions are processed in batches until done, within a per-run time and send budget. A learner keeps at most 5 subscriptions (the least recently subscribed is replaced).

All cron jobs of one tick share one Worker invocation, so they share a budget that tracks D1 queries (kept under Cloudflare's 1,000 per invocation) separately from subrequests (fetch, KV, R2 and D1; kept under 10,000) (`src/lib/jobs/cron-budget.ts`). Push reminders run first but cannot use a reserved slice kept for the cleanup jobs; each job charges what it used and resumes on the next tick.

Cleanup cron (`src/lib/jobs/`): guests with no runs inactive for 7 days, and guests with no progress inactive for 30 days, are erased; evidence images older than 24 h that no submission references (and whose owner has no recently touched open run) are deleted from R2. A 404/410 from the push service deletes the subscription; 5 consecutive failures disable it.

## ai-tutor insights (owner: insights module, issue #25)

Off by default. Every route below answers `404 not_found` while `INSIGHTS_MODE` does not enable the feature for the caller (`insightsEnabledFor`, `src/lib/insights/feature-flags.ts`): with `INSIGHTS_MODE=off` that is everyone, admins included, so the feature looks absent. A request with no session at all is answered `401` by the middleware before routing, exactly as for a path that does not exist. Wire details of the ingest side, flags, consents and retention: [insights-ingest-contract.md](insights-ingest-contract.md). Rollout and manual QA: [insights-rollout.md](insights-rollout.md).

### Insights (learner, web session)

Members only (guests get 404, except `pair/confirm`, which answers `403 forbidden` with a sign-in message). Every query is scoped to `locals.learner.id`; another learner's id is `404`. The same-origin rule of `/api/v1` applies.

| Method & path | Body | Response |
|---|---|---|
| `GET /api/v1/insights/settings` | – | `{ enabled: true, member: true, consents: {analysis, shareOperator, proposals}, devices, queue: {pending, lastReceivedAt}, retentionDays }` |
| `PATCH /api/v1/insights/consent` | `{ analysis?, shareOperator?, proposals? }` (at least one) | `{ consents }`. Granting `shareOperator` or `proposals` needs `analysis` (`400`). Turning `analysis` off turns the other two off and purges queued turns in the same batch; ingest is refused from then on |
| `POST /api/v1/insights/pair/confirm` | `{ userCode, approve }` (dash and case optional) | `{ status: "approved" \| "denied" }`; unknown, expired or decided code → `404`; limited per learner (`rate_limited` 429) |
| `DELETE /api/v1/insights/tokens/:id` | – | `{ revoked: true }`; revokes one of the learner's own devices (`itk_…`), anything else `404` |
| `GET /api/v1/insights/reports?cursor=&limit=&from=&to=&skill=&mission=&session=` | – | `{ reports: InsightReportView[], nextCursor, sessions, queue }` (`src/lib/insights/learner-report-queries.ts`). Expired reports are invisible; the product observation is never returned. Bad filters → `400 invalid` |
| `DELETE /api/v1/insights/reports/:id` | – | `{ ok: true }` |
| `POST /api/v1/insights/reports/:id/feedback` | `{ useful: boolean }` | `{ ok: true }` |
| `POST /api/v1/insights/reports/delete-all` | `{ confirm: "XOA" }` | `{ deleted }`; also removes the learner's queued turns |

Insight data is also part of `GET /api/v1/me/export` and `POST /api/v1/me/delete` (`LEARNER_TABLES`).

### Ingest (device token)

`/api/ingest/v1/{turns,status,token,pair/start,pair/poll}` is for the `ai-unlocked` CLI and Stop hook only. It sits **outside** the cookie session (`learnerPolicy` → `'none'`) and outside the `/api/v1` same-origin rule; instead it rejects any request that carries an `Origin` header (`403`). Auth is `Authorization: Bearer aiu_ing_…` (pairing endpoints take none and are IP-limited). Errors add a machine-readable `reason`: `{ "error": { "code", "message", "reason" } }`.

| `reason` | Status / `code` |
|---|---|
| `feature_off` | 404 `not_found` (checked first, before Origin, token or body) |
| `origin_forbidden` | 403 `forbidden` |
| `unauthorized` | 401 `unauthorized` |
| `consent_required` | 403 `forbidden` |
| `invalid_payload`, `payload_too_large`, `clock_skew` | 400 `invalid` |
| `rate_limited`, `slow_down` | 429 `rate_limited` |
| `daily_cap` | 429 `budget_exceeded` |

Bodies, responses and the client's behaviour per status are in [insights-ingest-contract.md](insights-ingest-contract.md).

### Admin insights

Admin (`ADMIN_EMAILS`) with the feature enabled; everyone else gets `404`. Pages: `/admin/insights`, `/admin/insights/learners/:id`, `/admin/insights/proposals` (all `noindex`, `no-store`).

| Method & path | Body | Response |
|---|---|---|
| `GET /api/v1/admin/insights/summary` | – | `{ health, patterns, signals, sharingLearners }` (`src/lib/insights/operator-insight-queries.ts`). Counts only, each bucket backed by ≥ 3 distinct learners with `analysis` consent; signals count only evidence from learners with `proposals` consent (≥ 3) and show only the de-identified signal title |
| `GET /api/v1/admin/insights/learners/:id/reports` | – | `{ learner, reports }`. Only when the learner has `observer_consent = 1`, `share_operator = 1` and `analysis = 1`, else `404` (unknown, non-consenting and revoked look the same). Every successful call writes an `insight_access_audit` row first |
| `GET /api/v1/admin/insights/proposals?status=` | – | `{ proposals: ProposalSummary[], settings }`; `status` is one of `proposed, duplicate, accepted, rejected, filing, issue_filed, shipped, monitored` (else `400`) |
| `GET /api/v1/admin/insights/proposals/:id` | – | `{ proposal, fingerprint, draft, issueMarkdown, issueTitle, privacyHits, monitoring }`. `issueMarkdown` is privacy-checked and `null` while the check blocks it ("Sao chép nội dung issue"). Open proposals show a freshly evaluated gate |
| `PATCH /api/v1/admin/insights/proposals/:id` | `{ action }`: `accept`, `reject`, `reopen`, `mark_duplicate {duplicateOf?}`, `mark_shipped {shippedRef?}`, `file_issue`, `approve_ai_handle {confirm: "AI-HANDLE", confirmHighRisk?: true}` | the detail as above. Invalid transition → `409`; `file_issue` → `409` while GitHub filing is off or the token is missing; `approve_ai_handle` → `400` without `confirmHighRisk` on a high-risk proposal, `409` unless the mode is `issues_ai_handle`; GitHub failure → `503` |
| `GET /api/v1/admin/insights/settings` | – | `{ githubMode, tokenConfigured, safeAutoImplement, dailyCap, issuesFiledToday }`. `tokenConfigured` is a boolean; the token never leaves the server-side publisher |
| `PATCH /api/v1/admin/insights/settings` | `{ safeAutoImplement: boolean, confirm: "BAT" }` | the settings as above |

`ProposalSummary` and the gate shape: `src/lib/insights/proposal-store.ts`, `GateDecision` in `src/lib/insights/insight-types.ts` (`decision`: `none`, `proposal`, `issue`, `issue_ai_handle`; `reasons` explain why it is weaker than `issue_ai_handle`). `insight_operator_settings` also holds internal keys written by `system:insights`: `proposal_stage:report_cursor`, `proposal_stage:signal_cursor` and the per-UTC-day issue counter `issues_filed:<YYYY-MM-DD>`.

### Test hooks

Stable `data-testid`s for the insights UI: `insight-report` (one report card, `/insights`), `insights-queue` (queue state line), `insights-disclaimer` (fixed observable-only notice), `insights-settings` and `insights-status` (Settings panel and its status chip, inside `section#s-insights`), `pair-device` (device being approved on `/insights/pair`).
