# Learning follow-ups (re-review N2, N3, N4, N8, dead code)

Branch `fix/learning-followups`. Part of #1.

## N2: a slow hint was charged but never shown
- Client: `api.hint` now waits `HINT_TIMEOUT_MS = 55_000` (`src/lib/ui/api-client.ts`). The server's worst case is 45 s (OpenRouter 15 s plus the Workers AI 30 s fallback).
- Server: `migrations/0006_run_hints.sql` adds `run_hints(run_id, step_id, level)`, which is unique and cascades on run delete, so privacy erase and guest cleanup need no changes. `src/lib/learning/hints.ts` reserves the row and charges `hints_used` in a single atomic batch. The charge is guarded on the reservation id. It then stores the generated text on that row.
- A retry of a level that is already unlocked returns the stored text. It makes no AI call and does not charge again. While the first request is still generating, a retry gets the static content hint without being charged.
- If the AI fails entirely, the static hint for that level is returned and stored, so a later retry gives the same text.

## N3: autosave got stuck on a locked answer (403)
- Server: the new `RevealedAnswerLockedError` (`src/lib/learning/errors.ts`) carries the run. `_route-helpers.ts` returns it as `403 { error, run }`.
- Client: on `forbidden`, `src/lib/ui/autosave-queue.ts` adopts the run from the response body. If the body has no run, it refetches with `api.getRun`. It restores the server value of the locked fields, which come from `run.revealed` through the new shared `src/lib/learning/reveal-keys.ts`, and clears their dirty state. Other fields and steps keep saving.
- The learner sees the notice "Câu này đã xem đáp án nên được giữ nguyên." in `RunnerHeader` (`role="status"`).
- If the same step is refused a second time, the whole step is reset to the server copy. A third refusal is reported as a failed save.

## N4: only the first pass counts
- `finalize-evaluation.ts` skips the competency update once the learner has a passing evaluation of that mission (`hasPassedMission`). Evaluations before the first pass (needs_revision) still update competency, as they did before.
- In `certificates.ts`, `hasStrongVerify` reads only the first passing evaluation per mission (`ROW_NUMBER` over `created_at, id`).

## N8: accessibility
- After a reveal, focus moves to the result: `tabIndex=-1`, `role="status"`, `aria-live="polite"`. Results that are already shown when the page loads do not take focus.
- The ✓ marker now has `role="img"`.

## Other changes
- Deleted `getMissionContent` from `service.ts`. It had no callers.
- Updated `docs/api-contract.md` for hints, the 403 response with `run`, and the certificate rule.

## Verification
`bun run content:check` OK; `bun run test` 39 files / 349 tests pass; `bun run build` 0 errors, 0 warnings. The one hint it prints is in `CopyButton` and was already there.

New tests:
- hint retry, hint in flight, stored static fallback
- 55 s hint deadline
- autosave 403: run in body, refetch, step reset, failure
- route 403 response with `run`
- first-pass competency
- first-pass strong verify

## Unresolved questions
- N4 interpretation: needs_revision attempts before the first pass still update competency, which is unchanged behavior. Only evaluations after the first pass are ignored.
- The progress-dot `span` in `RunnerHeader` (non-interactive mode) has `aria-label` without a role. This is the same class of issue as the ✓ marker but was not in scope, so it is left as is.
