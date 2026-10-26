# Code Review: 759ce05 "fix(autosave): explicit answer_locked signal, keep edits on other 403s" (#22)

Date: 2026-10-26 (Asia/Saigon). Reviewed at origin/main = 759ce05, detached checkout.

## Scope
- Files: `src/lib/ui/autosave-queue.ts`, `src/lib/ui/run-draft.ts`, `src/lib/ui/api-client.ts`, `src/lib/learning/errors.ts`, `src/pages/api/v1/_route-helpers.ts`, `src/components/mission/use-run-autosave.ts`, `src/lib/privacy/{export-learner-data,learner-data-tables}.ts`, `src/lib/jobs/{cron-budget,scheduled-jobs}.ts`, `src/lib/mcp/oauth-purge.ts`, plus tests and docs (19 files, +311/-106)
- Context read: `answer-reveals.ts` (server lock), `mission-runs.ts#saveAnswersImpl`, `submit-evidence.ts`, `use-run-session.ts` (submit/reveal), `mcp/tool-results.ts`, `migrations/0006_run_hints.sql`, `me/export.ts`, `@cloudflare/workers-oauth-provider` `purgeExpiredData` source
- Verification: `bun run test` 41 files / 376 tests pass; `bun run build` (astro check 0 errors / 0 warnings + build) pass. SQLite `EXPLAIN QUERY PLAN` for the run_hints export query. Cloudflare D1 limits page checked (1,000 queries per invocation on Paid, 50 on Free).

## Overall Assessment
The fix does what it claims. The client now trusts a 403 only when it has `code === 'answer_locked'`, `status === 403`, a valid run, `run.id === runId` and a `revealed` array. It restores only the fields the server's reveals lock, and it no longer has the old "second 403 resets the whole step" branch or the refetch fallback. That closes the data-loss path from the previous review. I found no Critical/High/Medium issues. The remaining items are Low and mostly about capacity or edge cases.

## Verified claims
| Claim | Result | Evidence |
|---|---|---|
| Server sends 403 `{error:{code:'answer_locked'}, run}` | CONFIRMED | `_route-helpers.ts:16` uses `err.apiCode`; every learner route goes through `errorResponse` (line 28). Covered by test `learning-answer-keys-and-reveals.test.ts:124` |
| Client recovers only on that code with a valid run for the same run id | CONFIRMED | `autosave-queue.ts:56-60`. `toApiError` maps a non-JSON or unknown-code 403 to `forbidden`. Tests cover non_json, generic forbidden with a run in the body, and answer_locked without a run |
| Only locked fields are restored | CONFIRMED | `autosave-queue.ts:102-107`: `clearDirtyFields(..., lockedFieldIds(revealed, stepId))`, then `mergeServerRun` re-applies every remaining dirty field. Client `lockedFieldIds` matches server `lockedFields`: only quiz/prediction are revealable (`revealableEntry`), and the prediction locks `choice`+`confidence` (shared constant) |
| Any other 403 keeps all edits | CONFIRMED | Falls to `onNotice(SAVE_REFUSED_NOTICE)`, `onState('offline')`, `return false`; draft untouched (test asserts `h.draft()` is the same object) |
| Loop terminates | CONFIRMED | Per drain: at most 3 conflicts, at most 2 lock recoveries per step, `MAX_SAVES_PER_DRAIN=50`; `settle` at most 10 rounds. A lock hit with no locked fields for the step exits immediately |
| restoreDraft prefers server values for locked fields | CONFIRMED | `run-draft.ts:149-155`. Non-dirty local values are always replaced by `mergeServerRun`, so clearing dirty flags on locked fields is enough |
| Export includes run_hints, paged, no cross-learner leak | CONFIRMED | `ownerCondition` scopes by `run_id IN (SELECT id FROM mission_runs WHERE learner_id IN (<owned ids>))`. The ids come from `ownedLearnerIds(session learner)` and the table name is allow-listed through `EXPORT_TABLES`. The plan uses the `(run_id, ...)` unique index plus the `mission_runs(learner_id)` index (no full scan). `rowid` exists (not a WITHOUT ROWID table). Delete relies on `ON DELETE CASCADE` (migration 0006) |
| Cron per-tick budget 900 | CONFIRMED | Under the 1,000 D1 queries per invocation limit (Paid) |
| OAuth purge charges by actual work | CONFIRMED | `oauthPurgeSubrequests` is capped at the reserved worst case; on failure the full reservation is charged (`finally`) |

## Data-loss audit (all error paths)
- Autosave PATCH: 409 merges and keeps dirty fields. `answer_locked` drops only the locked fields, which the server refuses anyway. Other 403s, 401, 4xx, 5xx, network errors and timeouts keep everything. Every `setDraft` goes through `commitDraft`, which mirrors to localStorage. No loss path found.
- Browser submit (`use-run-session.ts:193-247`): sends no answers, so the server checks the stored `run.answers` and a lock refusal can't happen. Every failure leaves the draft in place (an `invalid`/`conflict` error goes back to review; anything else goes to `evaluation_failed` with the draft kept). No change in this commit.
- Reveal: `settle()` must succeed first, otherwise it returns a message. A conflict merges with `mergeServerRun` (dirty fields kept).
- MCP: `RevealedAnswerLockedError` still has `code='forbidden'`, and `errorToToolResult` returns only code + message (no run). MCP keeps no local draft, so nothing can be lost there.

## Critical Issues
None.

## High Priority
None.

## Medium Priority
None.

## Low Priority
1. **Push reminder throughput drops from up to 1,000 to 176 sends per tick (CONFIRMED math, impact depends on scale).** `maxSends = min(1000, floor((900-20)/5)) = 176`. Push runs first, so in a busy reminder quarter-hour it can use the whole budget and push oauth-purge, guest-cleanup and evidence-gc to later ticks (only temporarily, because quiet ticks catch up). Reminders beyond the 60-minute catch-up window are skipped for the day. `PUSH_SUBREQUESTS_PER_SEND=5` counts the push `fetch` against the same pool as D1 queries, but the 1,000 limit is on D1 queries; fetch subrequests are limited separately. Fix if the scale calls for it: track D1 queries and fetch/KV subrequests in separate budgets, or lower the per-send D1 estimate to the measured count.
2. **Persistent `answer_locked` after 2 recoveries leaves the step dirty with no way out (PLAUSIBLE, edge case).** If client and server ever disagree on which fields are locked (for example, mission content changes a step's type while `revealed` still holds keys for it), every drain ends in `SAVE_REFUSED_NOTICE` and submit stays blocked. The notice says "try again later", which won't help. Nothing is lost, so this is acceptable, but a specific notice for the third lock hit would help support. `autosave-queue.ts:104-111`.
3. **The OAuth per-purge estimate assumes at most about 2 live tokens per grant (PLAUSIBLE undercount).** `revokeGrant` lists and deletes every token of the grant, so the real cost is `2 + tokens`. That is above `OAUTH_SUBREQUESTS_PER_PURGED=4` when a grant has more than 2 live tokens. The impact is bounded: these are KV ops (KV has its own per-invocation limit), and access tokens expire through TTL. `scheduled-jobs.ts:119-121`.
4. **No shape check on `dirty` in the localStorage draft (pre-existing, not a regression).** `restoreDraft` now calls `clearDirtyFields(...).filter` on each `dirty[stepId]`. A corrupted entry (null, or non-array values) throws inside `applyLoaded`, and the user gets `load_error` on every reload until storage is cleared. The previous `mergeServerRun` had the same failure for null. Validating `dirty` in `loadDraft` (treat a bad shape as "no local draft" or "no dirty fields") would remove it. `run-draft.ts:116-125`.
5. **Info: tabs still running the old JS during a deploy.** Old clients don't know `answer_locked`, so the old `toApiError` maps it to `forbidden` and the old recovery runs, including the old step-reset on a second 403. This is the same as before and goes away on reload. No action.

## Edge Cases Found by Scout
- Reveal made in another tab or device while this tab has a dirty edit to the same field: the edit is dropped with the notice. Intended, and the test covers it.
- A forced step (clean) holding stale non-dirty locked values: recovery replaces them with the server value through the merge, and the next PATCH succeeds.
- An `answer_locked` body whose `run.id` doesn't match (should never happen): rejected and treated as a generic refusal.
- `answer_locked` returned with a non-403 status: rejected (status checked).
- An export continuation URL with `table=run_hints`: allow-listed and owner-scoped.

## Recommended Actions
1. (Optional, depends on scale) Split the cron budget into D1-query and fetch/KV counts, or re-measure `PUSH_SUBREQUESTS_PER_SEND`, so reminder capacity isn't limited by the D1 cap.
2. (Optional) Validate the shape of `dirty` in `loadDraft`.
3. (Optional) Show a specific notice when lock recovery is used up.

## Metrics
- Tests: 376/376 pass. New tests cover the 4 refusal shapes, restoreDraft locked fields, run_hints export paging/isolation and OAuth charge math.
- Typecheck: astro check 0 errors / 0 warnings
- Lint: no separate lint script

## Plan follow-ups
The commit's stated items all appear complete: answer_locked signal, client gating, restoreDraft, run_hints export, cron 900 budget, OAuth proportional charge.

## Unresolved Questions
- What is the expected peak of push subscribers sharing one remind-time quarter-hour? This decides whether Low #1 matters.

Status: DONE
Summary: Verdict "clean": 0 Critical, 0 High, 0 Medium, 4 Low (1 confirmed capacity, 2 plausible, 1 pre-existing) + 1 info. Tests (376) and build pass.
