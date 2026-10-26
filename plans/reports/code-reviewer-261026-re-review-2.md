# Re-review 2: PRs #19 and #20 (unlock-zuey-me @ origin/main 8d87f9c)

## Scope
- Range `21f1872..8d87f9c`: e3c9822 (#19), 8d87f9c (#20). 43 files, +1230/−203.
- Focus:
  - whether N1–N6, N8 and the unused `getMissionContent` are fixed;
  - new bugs in budget math, cron budget, hint/autosave flows, migrations 0005/0006, D1 atomicity and a11y.
- Previous report: `origin/docs/review-reports:plans/reports/code-reviewer-261026-re-review.md`.
- Checks run:
  - `bun install`: ok.
  - `bun run test`: **41 files, 367 tests, all pass** (was 338).
  - `bun run build` (astro check + build): **exit 0, 0 errors, 0 warnings**. The one hint is the old `execCommand` deprecation in `CopyButton.tsx`.
  - e2e was not run (it targets production).

## Overall verdict
The fixes are real and well scoped. I found no Critical or High issues.

One Medium remains. Its code path is confirmed, but its trigger is only plausible: the new 403 handling in the autosave queue treats **any** 403 as "answer locked". On a 403 that has nothing to do with locking, it erases the learner's unsaved edits and persists that to localStorage. The other findings are Low.

---

## 1. Previous findings: verification

| ID | Status | Evidence |
|---|---|---|
| N1 coaching drains shared AI budget | **Fixed** | `ai-gateway.ts:28` maps `grade` to the `grading` pool and chat/hint to `coaching`. The pool is passed at `ai-gateway.ts:98,139`. `ai-usage.ts:125-140` (USD) and `:144-157` (Workers AI) add `AND (?flag = 0 OR coach_* + x <= coachCap)` to the global row inside the same uncorrelated-subquery conditional UPDATE, so the check stays atomic. Release and settle move `coach_*` by the same flag. Caps are `globalUsd × share` and `floor(workersAiGlobal × share)` (`ai-usage.ts:61-77`), with share 0.5 from `wrangler.jsonc`. Coaching can therefore never take more than 50%, and grading always keeps at least 50% of the USD budget and at least 1000 of the 2000 Workers AI calls. Tests: `tests/unit/coach-ai-coaching-share.test.ts` (7 cases). |
| N2 slow hint charged but not shown | **Fixed** | Client deadline is 55 s (`api-client.ts:68,148`). Server worst case is 15 s for the single coach model (`ai-models.ts:7`, `hint-coach.ts:74`) plus 30 s of Workers AI. The server reserves a `run_hints` row and charges `hints_used` in one batch, with the charge guarded on that row's id (`hints.ts:53-63`). A retry gets the stored text, or the static hint while generation is still running (`hints.ts:47-48,65-66`), and is not charged again. Concurrent duplicates are handled by `ON CONFLICT DO NOTHING` plus the guarded UPDATE. |
| N3 autosave stuck on locked answer | **Fixed (one Low left)** | The server returns 403 with the run (`errors.ts` `RevealedAnswerLockedError`, `_route-helpers.ts:16`). The queue restores the locked fields from `revealed` and keeps saving the other steps (`autosave-queue.ts:87-100`). The field mapping is shared with the server (`reveal-keys.ts`). `restoreDraft` was not changed (see L1). There is a new side effect (see M1). |
| N4 repeat runs count toward competency/certificate | **Fixed** | Competency EMAs are written only while `hasPassedMission` is false (`finalize-evaluation.ts:31-37,68`). The check runs before the current evaluation is inserted, so the first pass and the attempts before it still count, as the owner decided. `hasStrongVerify` only looks at the first passing evaluation per mission, via `ROW_NUMBER() OVER (PARTITION BY r.mission_id ORDER BY e.created_at, e.id)` (`certificates.ts:40-50`). Test: `learning-merge-evidence-and-repeat-runs.test.ts:132`. |
| N5 guest cleanup races merge | **Fixed** | `inactive-guest-cleanup.ts:74-85`. In one atomic batch, the guest is marked `deleted_at` only if the full eligibility predicate still holds. Every DELETE requires that mark plus `merged_into IS NULL`. R2 is deleted only when the learner row was actually deleted (`:106-115`). The merge is a single batch that sets `merged_into` (`guest-merge.ts:71`), and D1 serializes the two batches, so either order is safe. Test: `jobs-cleanup.test.ts:110`. |
| N6 parallel cron jobs share subrequests | **Fixed (one assumption to check; see L3)** | Jobs now run one after another against one shared budget (`scheduled-jobs.ts:69-81`, `cron-budget.ts`: 9000 subrequests and 8 minutes). Each job sizes its work to what is left. Evidence GC resumes from a saved key, so a page cut short mid-way loses no progress (`orphan-evidence-cleanup.ts:83-128`). |
| N8 focus lost after reveal; aria-label on span | **Fixed** | After the learner's own reveal, `Reveal` gets `tabIndex=-1` and focuses on mount (`QuizSteps.tsx:15-19,83,122`). A result already shown on load does not take focus. The ✓ span now has `role="img"` (`:79,114`). |
| Unused `getMissionContent` | **Removed** | `grep` finds no matches in `src/` or `tests/`. |

## 2. Migrations 0005 and 0006, including the production order (0006 before 0005)
- **0005** adds three `ADD COLUMN … NOT NULL DEFAULT 0` columns to `ai_usage`. This is safe on live data.
  - On deploy day, coaching spend from before 0005 is counted in the totals but not in `coach_*`. That day, coaching could therefore get up to half the cap again on top of what it already spent. The global total cap still holds. Negligible.
- **0006** is a new table `run_hints` with an FK to `mission_runs(id)` (a PRIMARY KEY) `ON DELETE CASCADE`. It starts empty.
  - D1 enforces foreign keys, so privacy erase and guest cleanup (which delete `mission_runs`) also remove the hints.
  - Nothing in `src` does `REPLACE` on `mission_runs`, so hints cannot be lost through an accidental cascade.
- **Applying 0006 before 0005 is safe:**
  - Wrangler picks unapplied migrations by **name**, not by the highest number applied (`node_modules/wrangler/wrangler-dist/cli.js:239585-239610`, `getUnappliedMigrationNames`). So the #20 deploy applied 0005 even though 0006 was already recorded.
  - The two migrations touch separate tables.
  - The #19 worker does not reference the `coach_*` columns.
  - In `deploy.yml`, migrations run before `wrangler deploy`. During the brief window between them, the old worker's `INSERT` into `ai_usage` leaves `coach_*` at the default 0, which is harmless.
- **Fresh databases** (tests, local) apply the migrations in numeric order, which is also fine.

## 3. New findings

### Critical
None.

### High
None.

### Medium

**M1. The autosave queue treats any 403 as "answer locked" and can erase unsaved learner edits (CONFIRMED code path; PLAUSIBLE trigger).**
- **The code path:**
  - `toApiError` maps every HTTP 403 to `forbidden`, including bodies that are not JSON (`api-client.ts:48-55`).
  - `autosave-queue.ts:88` then accepts any `forbidden`.
  - When the body carries no `run`, the queue falls back to `refetchRun` (GET), which succeeds.
- **What happens next:**
  - **First hit:** `lockedFieldIds(revealed, step)` clears nothing, because nothing is locked.
  - **Second hit:** `clearDirtyFields(current, stepId, current.dirty[stepId])` drops every dirty field of the step and replaces the values with the server copy.
  - `setDraft` goes through `commitDraft`, which calls `saveDraft` (localStorage), so the loss is persisted.
  - The queue then moves on to the next dirty step and repeats. Each step gets two attempts before its edits are dropped.
  - The learner sees "Câu này đã xem đáp án nên được giữ nguyên." ("This answer was already revealed, so it stays as it was.") That message is wrong in this case.
- **Before this PR**, the same 403 left the edits dirty and showed "offline", with no loss.
- **What can produce a non-lock 403 on PATCH while GET still works:**
  - Cloudflare WAF managed rules or bot challenges on request bodies (free-text answers in an AI course can contain SQL, code or `<script>`).
  - The middleware's Origin check (`middleware.ts:29-31`) behind a proxy or extension that rewrites `Origin`.
- **Fix:**
  - Treat a 403 as a lock only when the body has a typed signal, for example a distinct `error.code: 'answer_locked'`, or at least `body.run` present.
  - Drop the `refetchRun` fallback for 403s that are not lock errors.
  - Keep the "reset the whole step" escalation only for confirmed lock errors.

### Low

**L1. `restoreDraft` still prefers local dirty values over the server value for revealed fields (CONFIRMED, cosmetic).**
- This is the second half of N3 and was not done. `run-draft.ts:144-148` is unchanged, and loading does not flush the queue (`use-run-session.ts:56`).
- After a cross-device reveal, the locked (disabled) input shows the stale local choice, and `Reveal` computes "Chính xác" ("Correct") or "Chưa đúng" ("Not right yet") against it until the next edit, step change or submit triggers the 403 repair.
- Fix: in `restoreDraft`, clear the dirty flags in `lockedFieldIds(run.revealed, step)` for each step before merging.

**L2. `run_hints` is not in the privacy export (CONFIRMED, minor).**
- `LEARNER_TABLES` lists only tables that have a `learner_id`. `run_hints` is linked through `run_id`, so the guard test (`privacy-data-rights.test.ts`) did not catch it.
- Deletion is covered by the cascade. The hint text is also stored in `coach_messages`, which is exported. Only the per-run level/origin record is missing.
- Fix: add a join-based export, or a note in `learner-data-tables.ts` that tables owned through a run are covered by cascade and duplicated in `coach_messages`.

**L3. The cron budget assumes 10k subrequests per invocation; the D1 docs still list "1000 queries per Worker invocation" for Workers Paid (PLAUSIBLE).**
- The Workers limits page says 10,000 on Paid and counts D1, KV and R2 as subrequests. The D1 limits page lists 1000 queries per invocation (paid) in a row labelled "read subrequest limits". That row may be out of date.
- If the 1000 limit is real, a push tick near `MAX_SENDS_PER_RUN` (about 4 D1 queries per send) would hit it long before the 9000 budget.
- This does not matter at current traffic.
- Fix: check with Cloudflare or a load test. If unsure, add a separate D1-query sub-budget of about 900.

**L4. OAuth purge charges its worst case (500 × 10 + 6 = 5006) every tick, even when nothing has expired (CONFIRMED arithmetic, low impact).**
- `scheduled-jobs.ts:53-60`. On a heavy push tick (1000 sends, 5020 charged), about 4 subrequests are left after the purge. Guest cleanup then takes 1 guest, and evidence GC is skipped.
- Both catch up on quieter ticks, so this is acceptable. Charging the purge after it runs, based on what it actually did, would be more accurate.

**L5. Per-learner caps are still shared between coaching and that learner's own grading (PLAUSIBLE, self-inflicted).**
- With OpenRouter down or the USD budget spent, 60 chat or hint requests use up the learner's own 60/day Workers AI calls (`ai-models.ts:20`). That learner's submissions then fail as `evaluation_failed` for the rest of the day.
- This was not part of the N1 scope, which was global. Optional fix: apply the same coaching share to the learner row.

**L6. `Reveal` sets `role="status"` and also receives focus, so some screen readers read it twice (Informational).**
- Remove `role="status"`/`aria-live` when `focusOnMount` is true, or keep them. This is harmless.

## 4. Other checks with no issues found
- **Hint reservation SQL:** `INSERT … SELECT … WHERE EXISTS … ON CONFLICT DO NOTHING` has the WHERE clause SQLite needs to parse an upsert from SELECT. The ladder check stays atomic, and the charge cannot happen without the reservation.
  - If the worker dies after reserving, `text` stays NULL and later requests get the static hint forever. This is documented and acceptable.
- **Budget math:**
  - Reservations use `estimateCostUsd(model, input, maxTokens)`.
  - Settle subtracts the reservation from `coach_reserved_usd` only for coaching (flag × amount), and `MAX(0, …)` stops it going negative.
  - With a share of 0, coaching is always refused. Values outside [0, 1] fall back to 0.5.
  - The `exceededScope` labels are correct.
- **Submit lock check:** `assertRevealedUnchanged(mission, { ...run, status }, …)` uses the status from `effectiveStatus` (the run is not claimed yet), so the 403 body does not report `evaluating`.
- **403 body:** it contains only the caller's own run, the same as the 409. No answer keys.
- **Guest-cleanup batch:** the time-based mark plus the eligibility re-check is atomic. Overlapping cron ticks are impossible (8-minute budget, 15-minute interval).
- **Evidence-GC resume:** `after` advances only past objects that were fully examined. When a pass completes, the saved key is deleted.

## Recommended actions (priority order)
1. M1: limit the queue's lock handling to a typed lock error (a distinct code, or `body.run` present). Never reset steps on a 403 that is not a lock error.
2. L1: clear locked fields' dirty flags in `restoreDraft`.
3. L3: confirm the D1 per-invocation query limit for the account's plan.
4. Optional: L2 export note or join, L4 charge after the purge runs, L5 per-learner coaching share.

## Metrics
- Tests: 367/367 pass (41 files). Build/type check: 0 errors.
- Lint: no separate lint script exists; the astro check is clean.

## Unresolved questions
1. Does the production zone have WAF managed rules or Bot Fight Mode enabled for `/api/v1/*` PATCH? This decides how likely M1 is.
2. Which Workers plan does the account use, and is the D1 1000-queries-per-invocation limit still enforced (L3)?

Status: DONE_WITH_CONCERNS
Summary: clean. No confirmed Critical, High or Medium. All 8 previous items are verified fixed. New findings: Medium 1 (M1, plausible trigger on a confirmed code path; fixing it is recommended) and Low 6 (L1, L2, L4 confirmed; L3, L5 plausible; L6 informational).
