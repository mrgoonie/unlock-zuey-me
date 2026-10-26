# Phase 5 implementation report: proposal pipeline and GitHub issue gate (#25)

- Phase: `plans/261026-2235-25-ai-tutor-insights/phase-05-proposal-pipeline-github-gate.md`
- Branch: `feat/25-insights-phase-5` (merged with `origin/main` after phases 1 and 3 landed)
- Status: completed

## What was built

| File | Responsibility |
|---|---|
| `src/lib/insights/signal-fingerprint.ts` | `normalizeTopicKey` (lowercase, Vietnamese diacritics stripped, stopwords dropped, tokens sorted and de-duplicated, ≤ 48 chars), `normalizeArea` (fixed areas or `mission:<kebab>`, else `other`), `fingerprint` = sha256 of `v1\|category\|area\|topic`, and a de-identified `signalTitle` built from controlled fields only |
| `src/lib/insights/proposal-policy-gate.ts` | `classifyRisk` (denylist → high; content/bug in mission/concepts/labs/hints → low; everything else medium; the model hint is max-ed in, so it can only raise risk) and `evaluateGate` (the rule table from the phase file) |
| `src/lib/insights/issue-draft.ts` | Draft model call (`purpose: 'insights'`, `learnerId: 'system:insights'`, evidence fenced as untrusted data, zod sections ≤ 600 chars), deterministic template fallback, `renderIssueMarkdown` (all required sections, the fingerprint marker, the ai-handle ≠ auto-merge notice), `privacyCheck` (redact.mjs 0 hits, no internal ids, emails, non-unlock.zuey.me URLs, verbatim evidence runs ≥ 200 chars, or contributor display names), and `prepareIssue` (template on the first failure, blocked on the second) |
| `src/lib/insights/proposal-store.ts` | Signal upsert plus evidence link in one batch, consent-gated `cohortStats` (uses `CONSENT_SQL.proposalsConsented` plus `r.created_at >= proposals_at` plus `deleted_at IS NULL`), proposals (one per signal), triage transition table, filing lease, atomic per-UTC-day issue slot reservation, stage cursors, post-ship monitoring, dashboard views |
| `src/lib/insights/operator-settings.ts` | `getSafeAutoImplement` / `setSafeAutoImplement` and the key/value helpers |
| `src/lib/insights/github-issue-publisher.ts` | The only module of this phase that reads `GITHUB_ISSUES_TOKEN`. Provides search by marker, create, add labels and get state, with a 10 s timeout. Errors carry only the status and an endpoint template |
| `src/lib/insights/proposal-stage.ts` | The real stage: link (≤ 50 reports), evaluate (≤ 10 signals), file (≤ 3), and watch (≤ 5 issue checks, then shipped → monitored after 14 days). Also holds `fileProposal` (shared with the admin `file_issue` action), `proposalDetail` and `automationSettings` |
| `src/pages/api/v1/admin/insights/proposals/{index,[id]}.ts`, `settings.ts`, `proposals/_insights-admin-gate.ts` | Admin APIs. They return 404 to non-admins, and to everyone while `INSIGHTS_MODE=off` |
| `src/pages/admin/insights/proposals.astro`, `src/components/admin/insights/proposals/*` | Triage board, detail with the gate reasons panel and "Sao chép nội dung issue", and the automation toggle (typed confirm `BAT`). With no token it shows "Chưa cấu hình GitHub: chỉ tạo đề xuất trong dashboard" |

## Decisions and deviations

- **Issue body language:** the brief asks for English GitHub issue drafts, while the phase file names Vietnamese section headings. The issue body is English ("Aggregated evidence (N learners, M occurrences, 14 days)", "Privacy checks", "`ai-handle` ≠ auto-merge: every change still goes through a PR, CI and review"). The admin UI copy is Vietnamese.
- **Durable cursors and the daily counter live in `insight_operator_settings`** (keys `proposal_stage:report_cursor`, `proposal_stage:signal_cursor`, `issues_filed:<YYYY-MM-DD>`, written by `system:insights`), because migration 0008 has no column for them and new migrations are outside this phase. The issue counter is reserved atomically before each create, so concurrent filings cannot exceed 3 per day. Old day keys are pruned every tick.
- **Operator acceptance means "may be filed":** while GitHub mode is on, the cron files `accepted` proposals, and `file_issue` files immediately. Both re-run privacy, the cap and the gate at filing time. An operator overrides the gate's issue tier, but never the privacy check, the daily cap, or the `issues_ai_handle` mode requirement for `ai-handle`.
- **An issue closed as `not_planned`** moves to `rejected` rather than `shipped`.
- **An ambiguous create failure** (network or 5xx on POST) keeps the lease and the day slot, so the retry finds the issue by marker instead of creating a second one.
- The admin API tests live in `tests/unit/insights-proposal-stage-admin-api.test.ts`, not the plan's `insights-proposal-admin-api.test.ts`, so they fit the owned glob. Shared seeds are in `tests/unit/insights-proposal-stage-fixtures.ts`.

## Tests

- `insights-policy-gate.test.ts` (40): a 32-row bypass matrix, risk derivation, Vietnamese and English denylist terms, model hints that only raise risk, and injection text in the evidence or the draft inside the real stage.
- `insights-proposal-stage.test.ts` (20): paraphrase dedupe, one proposal per fingerprint, idempotent ticks, personal preferences ignored, cohort of 1 makes no model call, consent timing, revoke and delete cascade, template fallback, budget deferral, ai-handle labelling, a medium-risk hint, marker link, 30-day cooldown, concurrent filing making one POST, the daily cap of 3, a 422 releasing the lease and slot, and shipped → monitored. It also asserts zero GitHub fetches without a token.
- `insights-issue-draft-privacy.test.ts` (17): checks section completeness and every `privacyCheck` hit kind. A seeded secret, email, full prompt, learner ids and display names never reach the markdown, even when the model echoes its input.
- `insights-github-publisher.test.ts` (13): headers, the repo fallback, labels, marker filtering, 422/401/403/5xx, network failures and timeouts. The token never appears in errors or `console.error`.
- `insights-proposal-stage-admin-api.test.ts` (8): 404 gating, list and detail, transitions with 409, `file_issue` 409 without a token, ai-handle confirm returning 400 and 409, and the settings toggle. No response body contains the token.
- Full suite: `bun run test` 726/726, `content:check`, `migrations:check`, and `bun run build` (astro check 0 errors). The client bundle contains no GitHub code.

## Cross-phase requests

1. `tests/unit/insights-pipeline-job.test.ts`: only the `proposal` expectation line changed, to `{status: 'failed', error: expect.any(String)}`, because the real stage needs `env.DB`. The merge conflict with phases 1 and 3 was resolved as instructed.
2. Phase 4 owns `src/pages/admin/index.astro` and `/admin/insights`. It should add a link to `/admin/insights/proposals`.
3. Phase 6: `docs/api-contract.md` should document `GET /api/v1/admin/insights/proposals`, `GET/PATCH /api/v1/admin/insights/proposals/:id`, and `GET/PATCH /api/v1/admin/insights/settings` (shapes in the route headers). It should also note the internal keys in `insight_operator_settings`.

## Unresolved questions

- Should the issue body also carry the Vietnamese wording from the phase file? It is currently English only, per the brief.
- GitHub search may lag a few minutes behind issue creation. The lease (2 minutes) plus keeping the lease on ambiguous creates mitigates this, but a duplicate is still possible if GitHub indexing takes longer than the lease.
