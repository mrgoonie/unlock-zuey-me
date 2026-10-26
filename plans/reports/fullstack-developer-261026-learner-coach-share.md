# Learner coaching share and reveal a11y (issue #21)

Status: done. Branch `fix/learner-coach-share`.

## 1. Per-learner coaching share

- `src/lib/coach/ai-usage.ts`: `BudgetLimits` adds `coachPerLearnerUsd` (perLearnerUsd x share) and `coachWorkersAiPerLearner` (floor(60 x share) = 30 by default). The same single conditional UPDATE in `reserveUsd` / `reserveWorkersAiCall` now also checks the learner row's `coach_*` columns for coaching calls. Both rows still move together or not at all. Grading still may use the full per-learner cap.
- No migration was needed. The learner row already had the `coach_*` columns populated, because the reserve, release and settle statements always applied the coaching deltas to both rows (migration 0005 added the columns table-wide). The change is code-only, so deploy order does not matter.
- `src/lib/coach/ai-gateway.ts`: the `ai.budget_exceeded` event now reports a new scope `learner_coach_share` (or `workers_ai_learner_coach_share` for Workers AI) when the learner's own coaching share caused the refusal. Global scopes take precedence, as before.
- Behaviour change: with defaults, one learner's chat and hints may use at most $0.15/day of OpenRouter and 30 Workers AI calls. Their own grading keeps the rest.

## 2. Reveal a11y (`QuizSteps.tsx`)

- Dropped `role="status"` and `aria-live` from the result box. The box keeps `tabIndex=-1` and the focus move.
- Why focus wins:
  - Every result that appears after the learner's tap gets focus. The tapped button unmounts, so focus has to go somewhere anyway, and moving it there is what makes screen readers read the result.
  - A result already on the page at load should not be announced at all. It is read in document order.
  - A live region would not reliably help: it is mounted together with its content, and screen readers usually ignore a live region whose content arrives with it.
  - So the only case where focus does not move (on load) is the one that needs no announcement.

## Tests

- `tests/unit/coach-ai-coaching-share.test.ts`, 4 new tests:
  - A learner's coaching exhausts their own USD share while their grading still reserves, and another learner is unaffected.
  - Per-learner Workers AI share.
  - With OpenRouter down, a learner's chat is refused at 30 calls while their grading still runs.
  - The event scope for a USD refusal by the learner's coaching share.
  - The existing `budgetLimits` assertion was also extended.
- `tests/unit/coach-ai-budget-fallback.test.ts`: the concurrent-overshoot test now uses `purpose: 'grade'`. It tests concurrency against the full learner cap, and coaching now stops at half of it.
- New `tests/unit/quiz-steps-reveal-a11y.test.ts`: renders quiz and prediction results with SSR markup and asserts that the focusable result has no live region.
- Gates: `bun run content:check` OK, `bun run test` 382/382 pass, `bun run build` OK.

## Unresolved questions

- Should admin-format show a label for the new event scope? Scopes are not labelled today, so nothing was added.
