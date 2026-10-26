# Learning engine, evaluation, coach and v1 API (module C1)

Status: DONE · Branch `feat/learning-engine` (rebased on main after content #5, labs #4, platform #6 and UI #7) · Part of #1

## What shipped
- `src/lib/learning/service.ts`: original exported signatures kept (MCP calls them). Added `getRunWithEvaluation` and `getMissionContent`, plus re-exports for profile, chat, labs, concepts, recap, certificates, client events and evidence. `LearningDeps.fetchImpl` is optional and defaults to global fetch.
- The run state machine is in `mission-state-machine.ts`. An `evaluating` run older than 3 minutes counts as `evaluation_failed`, so a crashed evaluation can be retried. Editing a run in `evaluation_failed` moves it back to `started`.
- Answers are validated per step type against `stepFieldIds`. Limits: 8000 chars per text field, 30 list items, 64 KB per run. A stale `rev` returns `RunConflictError`, which the route sends as `409 { error, run }`.
- Evaluation: every check kind is scored by pure functions in `rubric-checks.ts`. All AI criteria go to the grader in one call. The fallback chain is `anthropic/claude-sonnet-5.5`, then `deepseek/deepseek-v4-pro` (strict json_schema, `provider.require_parameters`), then Workers AI `@cf/aisingapore/gemma-sea-lion-v4-27b-it`. Output is parsed as JSON and validated with zod: each criterion must appear exactly once and scores are clamped to 0..1. Learner text is fenced with a random boundary, and the grader is told to ignore instructions inside it. Images reach the model only as `[ảnh chụp màn hình đính kèm]`.
- Submit order: an existing idempotency key replays the stored result (`replayed: true`, stored rewards, nothing granted again). Otherwise the run is claimed with an optimistic update, the submission is stored, then evaluation runs. If every AI path fails, an evaluation with status `failed` is stored and the run moves to `evaluation_failed`. A new key re-evaluates the latest stored submission.
- Rewards: all XP and level rules live in `xp-and-levels.ts`:
  - Base XP is 10 × `estimated_minutes`.
  - Using no hints adds 20%.
  - Calibration adds 20% when |confidence/100 − score| ≤ 0.15.
  - Levels: L0 at 0 XP, L1 at 300, L2 at 1200, L3 at 3000.
  - `xp_ledger` holds one `mission_pass` row per run, written in the same D1 batch as the evaluation and the run status.
- Competencies use an EMA with α = max(0.3, 1/(n+1)). All 9 badge rule kinds are implemented: `calibrated` divides confidence by 100, and `transfer_pass` requires the current pass plus an earlier pass of its transfer variant. Activity days use the learner's timezone (default Asia/Saigon). The soft streak forgives one rest day per rolling 7 days.
- Coach: the 4-level hint ladder enforces order atomically in SQL. Hints use `google/gemini-3.1-flash-lite`, then Workers AI, then the authored static hint. Practice chat sends the last 12 messages, caps output at 700 tokens and allows 60 messages per learner per day. Coach messages are stored in `coach_messages`.
- Budget: `ai_usage` keeps one row per learner and one global row (`*`) per UTC day. Cost is estimated from the price table in `src/lib/coach/ai-models.ts`. When either the learner or global cap is reached, OpenRouter is skipped and Workers AI is used, capped at 60 requests per learner per day. The `ai.budget_exceeded` and `ai.fallback_used` events are emitted. KV rate limits are 20/min each for chat, hints and uploads.
- Routes: all `/api/v1` learning endpoints in `docs/api-contract.md`. Evidence uses the rest route `evidence/[...key].ts`: owners can always read; an admin can read only while the owner has `observer_consent = 1`, re-checked on every request; anyone else gets 404. The key param is decoded once, so both `ev/a/b.png` and the fully encoded `ev%2Fa%2Fb.png` that `EvidenceImageUpload` sends resolve. Uploads check magic bytes (PNG, JPEG, WebP, GIF) and reject files over 5 MB.
- Migration `0002_learning_rewards_and_ai_fallback_usage.sql` adds `evaluations.rewards_json` (used for replay), `ai_usage.workers_ai_requests` and two indexes.

## Integration notes (from the orchestrator)
- When `currentStep` moves forward in saveAnswers, the server emits `mission.step_completed` with `props.stepId` (and `nextStepId`). Because the server owns that event, it is not in the client allow-list. Allowed client events: `onboarding.completed`, `onboarding.skipped`, `mission.step_viewed` (requires `props.stepId`), `reflection.submitted`, `lab.started` (requires `props.labId`), `push.opened`.
- `PATCH /me/profile` accepts `goal`, `familiarity`, `obstacle`, `sound`, `reducedMotion` and `timezone` (must be a valid IANA zone). It is a strict schema and merges into the stored `profile_json` using camelCase keys from `LearnerProfile`.
- `POST /labs/:id/result` takes `{ result: {score, total, calibration?} }` and returns `{ labsDone, newBadges }`. Labs never grant XP.

## Tests
`bun run content:check` OK (8 missions, 41 concepts, 13 badges) · `bun run test`: 26 files, 207 tests pass (whole repo) · `bun run build`: astro check reports 0 errors and the build completes.
Coverage includes:
- every check kind;
- scoring, EMA, XP, levels, the state machine and streak math;
- the full submit flow on real SQL: pass, replay with no double XP, needs_revision, AI outage then retry, Workers AI fallback, foreign image keys, concurrent and stale submits, cross-learner `not_found` on every run function;
- budget fallback with a mocked fetch;
- grader injection resistance: prompt structure, a forged end marker, zod rejections;
- hint ladder and static fallback, practice chat;
- badges, labs, client events, profile, certificates;
- route tests for 401/409/404 and evidence consent being re-checked live.

## Concerns / follow-ups
- `tests/unit/learning-fake-env.ts` is a shared test helper. It does not match the `{learning,coach,api}-*.test.ts` ownership glob, but it lives in tests/unit under the `learning-` prefix.
- The identity module should parse `profile_json` with camelCase `LearnerProfile` keys (`reducedMotion`, `timezone`). The migration 0001 comment lists snake_case keys.
- Evaluation always uses the current mission content, even if a run started on an older `mission_version`.
- Vietnamese output quality from the grader and coach models has not been benchmarked. Static hints and the score-summary sentence are the floor.

## Unresolved questions
- Should the UI client still send `mission.step_completed`? This PR assumes no, because the server emits it.
