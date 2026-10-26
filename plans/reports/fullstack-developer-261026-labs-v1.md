# Labs v1 (module B) — implementation report

Status: completed · Branch: `feat/labs-v1` · Part of #1

## Outcome
Three client-only labs (no AI calls) at `/labs/<id>`, list at `/labs`, unknown slug → 404 page.

| Lab | Flow | Score |
|---|---|---|
| `token-predictor` Máy đoán chữ | 5 guess rounds (pick word + confidence → reveal authored distribution bars) → temperature slider + "đoán 10 lần" → tokenizer view (labelled approximation, VI vs EN) → takeaway | top-pick matches /5, `calibration` = 100·(1 − Brier) |
| `context-lab` Phòng thí nghiệm ngữ cảnh | toggle 3 context cards (8 authored answers, one per combination) → small/large context window, old messages fall off, allergy forgotten → new chat forgets until summary pasted → takeaway | check questions /3 |
| `hallucination-detective` Thám tử ảo giác | 3 cases × 4 claims, classify verified / needs_lookup / insufficient / expert, explanation + red-flag chips → red-flag summary | accepted verdicts /12 |

Every lab ends with takeaway + `/concepts/<conceptId>` link + "Thử mission" (`/missions`) + restart.

## Files
- `src/lib/labs/`: `registry.ts` (LABS, getLab, requireLab), `token-sampling.ts`, `tokenizer-approx.ts`, `calibration.ts`, `context-window.ts`, `detective-scoring.ts`, `lab-recorder.ts`, `*-data.ts` (3)
- `src/components/labs/`: 3 lab containers, step views, shared `LabIntro`, `LabStepHeading`, `LabTakeaway`, `OptionButtons`, `CheckQuestion`, `ProbabilityBars`, `ChatBubble`, `use-lab-started.ts`
- `src/pages/labs/index.astro`, `src/pages/labs/[slug].astro`
- `tests/unit/labs-*.test.ts` (4 files, 30 tests)

## Recording
- `lab.started` → `POST /api/v1/events {name, props:{labId}}` once per run, fire-and-forget.
- Completion → `POST /api/v1/labs/:id/result {result:{score,total,calibration?}}`; result sanitised (ints, score ≤ total, calibration 0..100). 404/5xx/network/bad JSON → gentle "chưa lưu được" note, never blocks. Also stored in `localStorage['labs.done']`; `/labs` merges it with `GET /api/v1/me` `progress.labsDone` to show "Đã xong".

## A11y / UX
Native buttons (`aria-pressed`), range input with `aria-valuetext`, focus moves to each new step heading, `aria-live` on reveals/answers/counters, 44px targets, tokens-only colours (dark mode verified), motion only via CSS transitions (covered by global reduced-motion rules). No chart lib, no zod in client bundle (lab islands 9–12 kB each).

## Verification
- `bun run content:check` OK · `bun run test` 35/35 · `bun run build` (astro check 0 errors/warnings/hints) OK.
- Playwright smoke at 375px against `wrangler dev` of the build: all 3 labs click through to the takeaway, POST payloads correct, only console errors are the 404s from not-yet-implemented API endpoints; `/labs/nope` → 404. Preview server stopped afterwards.
- `astro dev` cannot start in this sandbox (the `AI` binding needs a remote session); `wrangler dev` of the build works.

## Needs from other modules
- Content: a concept with id `token` (token-predictor ends on `/concepts/token`); `context` and `hallucination` already exist. Optionally set `lab: token-predictor` on it.
- Engine: `POST /api/v1/labs/:id/result` should accept `{score,total,calibration?}`; `/api/v1/events` should allow `lab.started` with `props.labId`.
- Home/UI: import `LABS` / `getLab` from `src/lib/labs/registry.ts`.

## Unresolved questions
- Mission CTA links to `/missions` (no lab→mission mapping in the schema). Add a mapping later if a specific mission per lab is wanted.
