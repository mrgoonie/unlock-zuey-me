# Learner UI (C2): implementation report

Status: completed. Branch `feat/learner-ui`. Part of #1.

## What shipped
- `/start`: three skippable onboarding questions shown as choice cards. Answers are sent with `PATCH /api/v1/me/profile`, then the learner goes to `/home`. A failed save never blocks them.
- `/home`: greeting, guest banner (`/auth/zuey/login?return_to=/home`), a continue card for an in-progress run, 3 recommended missions, a lab card, streak and XP chips, latest badge and level bar.
- `/missions`: list filtered by competency and time through query params, so it works without JS. `/missions/[slug]`: outcome, why it matters, time, risk, safety notes, competencies, related concepts and Start/Continue/Redo. Unknown slugs return a 404.
- `/missions/[slug]/run`: the `MissionRunner` island.
  - Shows one step per screen, with clickable progress dots.
  - Renders all 7 step types, including list fields, prompt copy, "Mở ChatGPT", the practice chat (native `<dialog>`), the paste box and image upload. Quiz and prediction have a reveal that locks the answer.
  - 4-level hint ladder that falls back to the authored static hint when the coach call fails.
  - Pre-submit self-confidence slider.
  - Run states: evaluating (polls `GET /runs/:id` after a reload), needs_revision (criterion rows link back to the step to fix), evaluation_failed (reassures, retries with the same key) and passed.
- Results: total %, criterion bars with feedback, strengths/improvements, a calibration line, XP count-up, new badges, level-up and a verification answer key (shown only after passing). Next-step buttons: transfer variant, next recommended mission, share. Confetti is canvas-based; SFX are synthesized with WebAudio. Both are off under reduced motion, and SFX are opt-in through `profile.sound`.
- `/progress`: level, 6-axis SVG radar plus a list, a 7-day streak strip, weekly recap (island) and completed missions. `/achievements`: earned and locked badges with how to earn each, plus the certificate request (the server decides eligibility and its 403 message is shown).
- `/certificates/[code]`: public page with a bare layout. It runs a D1 query that skips revoked certificates; unknown/revoked codes get 404 and DB failures 503. It has OG/canonical meta, Web Share and copy link.
- `/concepts`: accent-insensitive search, group filter, layer badges and "cần kiểm tra lại". `/concepts/[slug]`: full explanation with the rigorous part in `<details>`. A view beacon fires `POST /concepts/:id/view`.

## Key decisions
- **Server rendering:** pages call `src/lib/learning/service.ts` (`getProgress`, `listMissions`) through `src/lib/ui/server-data.ts`. They do not call the HTTP API. When the service fails, pages fall back to static content: missions from the loader, and progress sections hidden behind a reassuring card.
- **Autosave** (`use-run-autosave.ts` + `lib/ui/run-draft.ts`):
  - Every edit is mirrored to localStorage, then saved with a debounced (800 ms) PATCH that sends the whole step's answers and `rev`.
  - On a 409 the client adopts the server run, re-applies its dirty fields on top, and retries (at most 3 times).
  - A network failure keeps the dirty flags; saving is retried on the next edit, a step change, the `online` event or `visibilitychange`.
  - Submit is refused until everything has been saved.
- **Idempotency key:** one per attempt, generated with `crypto.randomUUID`, stored in the draft together with a fingerprint of answers, confidence and images. Identical evidence reuses the key, so timeouts and evaluation_failed retries are safe. Changed evidence, or a definitive grade (passed / needs_revision), means a new key.
- **Hints, quiz reveals and image keys** are local draft state, so a reload does not cost another hint.
- **Labs:** `src/lib/labs/registry.ts` did not exist, so `src/lib/ui/lab-links.ts` holds a static list of token-predictor, context-lab and hallucination-detective.

## Edits outside the owned folders (additive)
- `src/styles/global.css`: adds the `.bar`, `.bar-fill` and `.choice` component classes.
- `AppLayout.astro` was not changed.

## data-testid (for Playwright)
- **Runner:**
  - `runner-loading`, `runner-step` (has `data-step-id`), `runner-next`, `runner-back`, `progress-dots`, `save-state`
  - `hint-ladder`, `hint-button`, `hint-level-{n}`
  - `field-{fieldId}`, `claim-{claimId}`, `quiz-{questionId}`, `prediction-confidence`
  - `prompt-suggestion`, `open-practice-chat`, `practice-chat`, `evidence-upload`
- **Submit and outcomes:**
  - `submit-review`, `self-confidence`, `submit-evidence`
  - `evaluating`, `needs-revision`, `revise-start`, `evaluation-failed`, `retry-submit`
- **Results:**
  - `results`, `result-score`, `criterion-{id}`, `criterion-score`
  - `xp-gained`, `level-info`, `badge-{id}`, `calibration`
  - `cta-transfer`, `cta-next`, `cta-share`
- **Other pages:**
  - `onboarding-option-{value}`, `mission-card-{id}`, `mission-detail`, `mission-start`
  - `continue-run`, `home-lab`, `guest-login`, `latest-badge`, `level-bar`, `xp-total`
  - `streak-chip`, `streak-week`, `competency-radar`, `weekly-recap`
  - `badge-card-{id}`, `certificate-request`, `certificate-ready`, `certificate`, `certificate-share`
  - `concept-card-{id}`, `concept-detail`, `not-found`

## Verification
- `bun run content:check` passed. `bun run test` passed: 39 tests, 34 of them new UI tests covering draft merge on 409, idempotency keys, the localStorage mirror, api client error mapping and timeouts, radar geometry, step gaps, criterion→step mapping, calibration, level-up, concept search and certificate snapshot parsing. `bun run build` passed with 0 errors.
- Manual run at 375px in light and dark mode, using `wrangler dev` on the build with `/api/v1` mocked through Playwright route interception (the engine was not merged yet). The full plan-weekend flow from intro to results ran with no page errors. Two issues were fixed afterwards: the exit button wrapped onto two lines, and list fields started with only one row.

## Limitations / follow-ups
- The streak strip is built from `streak.current`, because the progress contract has no per-day history. Exact rest-day placement needs a day list added to `ProgressSummary`.
- `Recap.competencyDeltas` has no fixed shape in the contract. The UI accepts either a map or a list, on a 0..1 scale.
- Certificate `snapshot_json` has no fixed shape in the contract either. It is parsed defensively (`competencies` as a list or map, `missionsCompleted` as a number or array).
- `level.name` comes from the engine. The certificate page shows only the level code.

## Unresolved questions
- Should submitting again with an unchanged idempotency key after `evaluation_failed` re-run grading? The UI assumes yes, following the service.ts doc ("retry re-evaluates it").
- Is `POST /api/v1/events` allow-listing `onboarding.completed` / `onboarding.skipped`? The UI sends them fire-and-forget.
