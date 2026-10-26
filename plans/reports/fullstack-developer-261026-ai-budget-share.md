# AI budget share, guest cleanup race, sequential cron

Branch `fix/ai-budget-share` (merged with origin/main after #19). Checks: `content:check` OK, `test` 41 files / 367 tests pass, `build` 0 errors / 0 warnings.

## N1 (Medium): coaching can no longer starve grading
- New additive migration `migrations/0005_ai_usage_coach_share.sql`: `ai_usage.coach_cost_usd`, `coach_reserved_usd`, `coach_workers_ai_requests` (coaching part of each row; totals still include it).
- `src/lib/coach/ai-usage.ts`: every reserve/release/settle takes a `BudgetPool` (`grading` | `coaching`). For coaching, the same single conditional UPDATE also requires the global row's coaching spend + amount <= `globalUsd × share` (USD) and coaching Workers AI calls < `floor(workersAiGlobal × share)`. Grading checks only the full caps. Coaching spend still counts toward the total.
- `src/lib/coach/ai-gateway.ts`: `budgetPool(purpose)` maps `grade` to grading and `chat`/`hint` to coaching. Budget events gain scopes `coach_share` / `workers_ai_coach_share`.
- Config: wrangler var `AI_DAILY_COACH_SHARE` ("0.5"), typed in `src/env.d.ts`, default `DEFAULT_COACH_SHARE = 0.5` in `ai-models.ts`; values outside [0, 1] or malformed fall back to 0.5.
- Behaviour when the share is used up: chat falls back to Workers AI within its share, then gets the existing "hết lượt" `budget_exceeded` message; hints fall back to the static hint; grading keeps working.
- Tests: `tests/unit/coach-ai-coaching-share.test.ts` covers grading reserving OpenRouter after the chat share is exhausted, chat budget error while grading still runs on Workers AI, static hint fallback, the friendly chat message, pool accounting, and share parsing. One existing test in `coach-ai-budget-fallback.test.ts` now uses `purpose: 'grade'` to test the full global Workers AI cap.

## N5 (Low): guest cleanup vs sign-in merge
- `src/lib/jobs/inactive-guest-cleanup.ts`: the eligibility predicate is shared by the scan and the deletion. The deletion runs as one atomic D1 batch. Its first statement sets `deleted_at` only if the guest still qualifies (unmerged, `kind='guest'`, inactive, and the other rules). Every following DELETE applies only to a marked guest. R2 images are deleted only after that batch removed the guest row. If the R2 step fails, the orphan-evidence job cleans those images up later because their owner no longer exists.
- Result now reports `skipped` and `deferred`.
- Tests (`jobs-cleanup.test.ts`): a merge between the scan and the deletion skips the guest, keeps its rows and never calls R2 list/delete. A guest that came back is skipped too.

## N6 (Low): cron subrequest limit
- New `src/lib/jobs/cron-budget.ts`: a shared budget of 8 min and 9,000 subrequests per tick.
- `scheduled-jobs.ts`: jobs run sequentially (push reminders first, then oauth-purge, guest cleanup, evidence GC) with per-job try/catch. A job is deferred when the budget is already spent.
- Push reminders get `maxSends` and `timeBudgetMs` derived from the remaining budget. If an attempt fails, the worst case is charged. OAuth purge gets a batch size sized to what is left (new optional `batchSize` param in `src/lib/mcp/oauth-purge.ts`). Guest cleanup and evidence GC charge as they go and stop early.
- Evidence GC now saves the last examined key (`evidence-gc:after`, R2 `startAfter`) instead of a page cursor, so it can stop mid-page and resume at the next object. The old `evidence-gc:cursor` KV entry is ignored and expires within 7 days.
- Tests: `jobs-scheduled-dispatch.test.ts` covers order, no overlap, failure isolation, the shared budget and the time budget. `jobs-cleanup.test.ts` covers the budget for guest cleanup and mid-page GC resume.

## Notes
- The subrequest costs of push reminders and the OAuth purge are conservative estimates. The other jobs charge their actual calls.
- Prod migration: 0005 is applied after the already-applied 0006. wrangler applies unapplied migrations by name, so this is fine.

## Unresolved questions
- Whether 8 min / 9,000 subrequests match the account's actual Workers plan limits. Adjust `CRON_TIME_BUDGET_MS` / `CRON_SUBREQUEST_BUDGET` if the plan differs.
