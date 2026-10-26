# Phase 0 implementation report: insights contract, schema, flags, shared redaction

## Executed phase

- Phase: `phase-00-contract-schema-flags-redaction`
- Plan: `plans/261026-2235-25-ai-tutor-insights/`
- Branch: `feat/25-insights-phase-0` (from `origin/main` at 2c65486)
- Status: completed. Nothing user-visible changes: `INSIGHTS_MODE` defaults to `off`.

## Files

Created:
- `migrations/0008_insights.sql`: 9 additive tables and their indexes. Passes `migrations:check` and applies on local wrangler D1.
- `src/lib/insights/insight-types.ts`, `ingest-contract.ts`, `feature-flags.ts`, `pipeline-job.ts`
- `src/lib/insights/retention-stage.ts`, `analyzer-stage.ts`, `proposal-stage.ts`: stubs with signature `(env, budget, now)`
- `skills/ai-unlocked/scripts/lib/redact.mjs` and `redact.d.mts`
- `docs/insights-ingest-contract.md`
- Tests: `insights-redaction`, `insights-migration-schema`, `insights-feature-flags`, `insights-ingest-contract`, `insights-pipeline-job` (all `tests/unit/*.test.ts`)

Modified:
- `src/env.d.ts`: 7 optional vars and the `GITHUB_ISSUES_TOKEN?` secret
- `wrangler.jsonc`: insights vars (mode `off`, GitHub `off`) and a note on the secret
- `src/lib/jobs/scheduled-jobs.ts`: `insights-pipeline` appended last
- `src/lib/privacy/learner-data-tables.ts`: 5 learner tables placed before `ai_usage`; `insight_tokens` omits `token_hash` from export
- `tests/unit/observer-seed-fixtures.ts`: one row per new learner table
- `tests/unit/jobs-scheduled-dispatch.test.ts`: the job-list line
- `plans/.../plan.md`: the open questions are now recorded as resolved
- `plans/.../phase-00-...md`: implementation notes added

`tsconfig.json` was not touched, because `astro check` accepts the `.mjs`/`.d.mts` pair.

## Tasks

- [x] Additive migration 0008 with unique keys, CHECKs, and the evidence → report cascade
- [x] Redaction rule set (PEM, sk-/sk-ant-/sk-or-/sk-proj-, GitHub, AWS, Slack, Google, JWT, bearer, URL params, key=value including "mật khẩu", email, home paths → `~`, CCCD/CMND, Luhn cards, VN phone, IBAN, IPv4, high-entropy). Inputs are capped and quantifiers bounded. The rules are idempotent.
- [x] zod ingest contract v1 (strict), with caps, `PAIR_*` constants, error reasons, and helpers
- [x] Feature flags: mode matrix, members only, pilot emails, GitHub mode forced `off` without a token, numeric var parsers
- [x] `runInsightsPipeline`: `{skipped:'flag_off'}` when off, touching nothing and charging nothing. Otherwise retention → analyzer → proposal, each in try/catch and deferred once the budget is exhausted. Integrated with the current `CronBudget` API (#28) and run last.
- [x] Privacy registry, export and delete coverage, with tests
- [x] Env, wrangler and contract doc

## Tests

- `bun run content:check`: OK
- `bun run migrations:check`: OK (0008 checked)
- `bun run test`: 51 files, 538 tests pass (96 new insights tests)
- `bun run build` (`astro check` + build): 0 errors, 0 warnings
- `bun run db:migrate:local`: applies 0001–0006 and 0008

## Contract decisions phases 1–5 must know

- `githubIssuesMode` also returns `off` while `INSIGHTS_MODE=off`. Tests that expect `issues` must set the mode.
- Error bodies are `{error:{code,message,reason}}` via `ingestError(reason, msg)`. Reasons: `unauthorized`, `consent_required`, `origin_forbidden`, `feature_off`, `invalid_payload`, `payload_too_large`, `clock_skew`, `rate_limited`, `daily_cap`, `slow_down`.
- The payload schema is strict: adding a field means bumping `v`. `redaction.kinds` accepts any `[a-z_]{1,32}`.
- `redactValue` returns `{value,count,kinds}`. The server applies it to `turn` only, because `idempotencyKey` and `sessionRef` would match the high-entropy rule.
- The doc adds details the plan left open: `DELETE /token` → `{revoked:true}`, poll faster than every 4 s → `429 slow_down`, and the hook's per-status behaviour table. Phases 1 and 2 implement these, or amend the doc in phase 6.
- A standalone 12-digit number is redacted as `national_id`, as the spec asks. A 13-digit ms timestamp that happens to pass Luhn is masked as `card`. These are accepted false positives.

## Unresolved questions

- None blocking. Phase status cells were not changed, following the `ak plan` rule. The orchestrator should mark phase 0 done once this PR is merged.
