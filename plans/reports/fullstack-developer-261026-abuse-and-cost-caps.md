# Abuse and cost caps (review findings H1, M4, L2, L9)

Status: done. Branch `fix/abuse-and-cost-caps`, based on `main` at 9797ea8.

## H1: abuse and AI cost
- **Per-IP throttles.** Four Workers Rate Limiting bindings are declared in `wrangler.jsonc` (`ratelimits`, period 60 s).
  - `RL_GUEST_IP` (20/min) gates guest creation.
  - `RL_AI_IP` (30/min per endpoint) covers chat, hints, submit and upload.
  - `RL_WRITE_IP` (120/min) and `RL_WRITE_LEARNER` (30/min) cover the M4 endpoints.
  - The rules and the route table live in `src/lib/identity/request-rate-limits.ts`. IPv6 clients are keyed by /64.
  - `src/middleware.ts` runs the per-IP check before any guest is created and the per-learner check after the session resolves.
  - A blocked request gets the API `rate_limited` 429. A page whose guest creation is blocked renders without a learner, the same way it does for bots.
  - When a binding is missing (tests, tooling), an in-memory per-isolate window with the same numbers takes over. If the binding throws, the request is allowed and the error is logged.
- **Global Workers AI cap.** The `'*'` row in `ai_usage` now enforces `AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL` (default 2000/day). When OpenRouter and Workers AI are both exhausted, the caller gets the existing `AiUnavailableError('budget')`:
  - chat shows the friendly `budget_exceeded` message;
  - hints fall back to the static hint;
  - submit leaves the run in `evaluation_failed` with the evidence kept.
- **No overshoot under concurrency.** `src/lib/coach/ai-usage.ts` reserves before each call and settles after it.
  - OpenRouter: one conditional `UPDATE` adds the worst-case cost to `reserved_usd` on the learner row and the global row together, or on neither. After the call, `settleUsage` replaces the reservation with the real cost, or `releaseUsd` drops it if the call failed.
  - Workers AI: calls are counted up front with the same conditional pattern.
  - A test covers 10 parallel calls: exactly 3 fit the budget.
- **Coach chat.**
  - Assistant turns are kept only if they exactly match a reply the server stored for that learner in the last 24 h.
  - History is capped at 12 messages and 8000 characters. A request may carry at most 20 messages (was 50).
- **Cleanup crons** (registered in `scheduled-jobs.ts`):
  - `inactive-guest-cleanup.ts` erases guests through `deleteLearnerData`, 50 per run:
    - guests with no runs and inactive for 7 days;
    - guests with no XP or badges and inactive for 30 days.
    - Merged guests, guests with a certificate and members are never touched.
  - `orphan-evidence-cleanup.ts` deletes `ev/` objects that meet all of these conditions:
    - older than 24 h;
    - not referenced by any submission of the owner or of the member the owner was merged into;
    - the owner has no open run touched in the last 7 days. This protects images attached to an unsent browser draft.
    - Objects whose owner no longer exists are always deleted.
    - It walks 2 R2 pages per run and keeps its cursor in `CACHE`.
- **Migration `0003_ai_reservations_and_cleanup_indexes.sql`** (additive): adds `ai_usage.reserved_usd`, a `learners(kind, created_at)` index and a `lab_runs(learner_id, lab_id, created_at)` index.

## M4: row-writing endpoints
- Events, lab results, mission start and push subscribe are throttled per IP and per learner in the middleware.
- `lab_runs` is capped at 20 per learner, lab and UTC day with a single atomic `INSERT … SELECT WHERE count < cap`. Past the cap the endpoint still answers `labsDone`.
- Push subscriptions are capped at 5 per learner. The least recently (re)subscribed device is replaced, in the same batch as the upsert.
- The export is bounded:
  - at most 1000 rows per table and about 8 MB of row JSON in total;
  - at most 5000 image keys.
  - Tables that were cut off appear in `continuation` with a `?table=&after=` rowid cursor, served by `GET /api/v1/me/export`. The table name must be one of the learner tables.

## L2: Workers AI timeout
- `workersAiChat` now takes a timeout and wraps the call in `withTimeout`. The gateway passes 30 s (`WORKERS_AI_TIMEOUT_MS`).
- Not done: the second half of the finding (make the finalize `UPDATE` check `rev`). It belongs in `finalize-evaluation.ts`, which this task was not allowed to touch.

## L9: push reminders past 100 per window
- The reminder job now loops in batches of 100, sending up to 6 in parallel, until no due subscriptions remain.
- Each run stops after 5 min or 1000 sends, whichever comes first. This keeps it inside the shared cron invocation's limits.
- Each run also looks back 60 minutes for reminders that were due earlier the same local day and not sent yet. Anything a full run had to defer is picked up by the next run.

## Verification
- `bun run content:check`: OK.
- `bun run test`: 36 files, 322 tests, all pass.
- `bun run build`: 0 errors, 0 warnings.
- `wrangler types` parses the new `ratelimits` config.
- New tests:
  - `identity-request-rate-limits.test.ts`
  - `jobs-cleanup.test.ts`
  - `learner-write-caps.test.ts`
  - global cap, reservation and timeout cases in `coach-ai-budget-fallback.test.ts`
  - batching and look-back cases in `push-reminder-job.test.ts`
  - forged-turn and character-cap cases in `coach-hints-and-chat.test.ts`
- Docs: `docs/api-contract.md` now describes the throttles, the chat history rule, export paging and the crons.

## Concerns
- The rate limit counters are per Cloudflare location and approximate, by design. The hard money caps are the D1 budgets.
- The 20 guests/min/IP limit could affect a class sharing one carrier NAT. When it triggers, pages still render, and only new API sessions get 429 for up to a minute.
- An evidence image that sits in a browser draft whose run is untouched for more than 7 days can be deleted. The learner keeps their text and has to upload the image again.
- If a Worker dies mid-call, its USD reservation stays until the UTC day rolls over. This errs on the safe side.
- Migration number 0003 may collide with a parallel branch. Renumber at merge if needed.

## Unresolved questions
1. Should practice chat be limited to members (review question 2)? Not changed here.
2. Is 2000/day the right global Workers AI cap? It is tunable in `wrangler.jsonc` vars.
