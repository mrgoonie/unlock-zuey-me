# Runner: abandon a run (#17) and draft robustness (#24)

Status: done. `bun run content:check`, `bun run test` (43 files, 395 tests) and `bun run build` pass. No migration.

## #17 Abandon an open run
- Engine: `abandonRunImpl` in `src/lib/learning/abandon-run.ts`, exposed as `abandonRun` in `service.ts`. It runs the state machine `abandon` event, uses a rev-guarded UPDATE (retried up to 3 times when a concurrent save bumps rev), and emits `mission.abandoned`. Calling it on an already-abandoned run returns that run. A completed run, or one still being graded, is `conflict`. A crashed evaluation (effective `evaluation_failed`) can be abandoned, and its late finalize then does nothing because finalize requires `status = 'evaluating'` at its rev. No XP, evaluation or `completed_at` is written. The run leaves the open-run partial index, so the next start creates a fresh run.
- Route: `POST /api/v1/runs/:id/abandon` uses `withLearner`/`errorResponse` and the middleware origin check. Another learner's run returns 404.
- Rate limit: the per-learner limit is checked inside the route (`RL_WRITE_LEARNER`, key `abandon:<learnerId>`), because the shared route table in `src/lib/identity/request-rate-limits.ts` is outside this task's file ownership.
- MCP: added an `abandon_mission` tool in `run-tools.ts`. It requires learn:write and is marked destructive and idempotent.
- UI: `AbandonRunControl.tsx` is an inline disclosure with a confirm step. Opening it moves focus to "Làm tiếp", Escape closes it, all targets are at least 44px, and errors use role=alert. It appears on the steps, review, needs_revision and evaluation_failed screens, but not while grading. Confirming abandons the run on the server, removes the local draft and opens a fresh run with `again: true`.
- Content gate: `scripts/validate-content.ts` now has a `revealLockErrors` check. It sets every criterion decided only by revealable items to 0 (quiz_score on a quiz step and prediction_correct) and every other criterion, including AI ones, to 1. If the resulting weighted score is still below pass_score (same 1e-9 tolerance as decideStatus), the check fails. The script's main code now runs only under `import.meta.main`, so tests can import it. All current content passes.

## #24 Draft robustness
- `parseStoredDraft` / `loadDraft` validate the whole stored shape and never throw. A draft with bad JSON, a different runId or malformed answers is dropped and removed from storage. A malformed dirty map, hints, imageKeys, confidence or attempt is reset to its default. Dirty flags that have no value are dropped. `use-run-session` also wraps restore with a fallback to the server copy.
- Lock recovery exhausted: the queue calls `onLockExhausted(stepId)` when recovery runs out, or when the server locks a field the client cannot map from `revealed`, which is the real client/server disagreement case. In both cases every edit is kept. RunnerHeader then shows a Vietnamese alert with the button "Tải lại bước này từ máy chủ". `queue.reloadStep` fetches the run, drops only that step's unsaved edits, and saves the other steps. If the fetch fails, nothing is discarded.

## Tests
- `tests/unit/learning-abandon-run.test.ts`: owner, idempotent, no XP/evaluation, new run after abandon, cross-learner 404, completed and grading refused, crashed evaluation allowed, the route (401/404/200/409), the per-learner throttle, and the MCP tool (scope, foreign run, success).
- `tests/unit/content-reveal-lock-check.test.ts`: the scoring formula, a failing mission, the exact boundary, and shipped content.
- `ui-run-draft.test.ts`: malformed drafts, a bad dirty map, and discarding one step's edits. `ui-autosave-queue.test.ts`: the exhausted flag plus reload, an unmappable lock, and a failed reload. `ui-api-client.test.ts`: the abandonRun request.

## Deviations
- "Discard only that step's unsaved locked fields": when client and server disagree, the client cannot tell which fields the server treats as locked. The reload therefore drops all unsaved edits of that one step. Other steps are untouched.
- E2E was not run because the Playwright config targets production.

## Unresolved questions
- Should `runs/:id/abandon` also get a per-IP limit in the shared route table (`src/lib/identity/request-rate-limits.ts`, owned by the identity module)?
