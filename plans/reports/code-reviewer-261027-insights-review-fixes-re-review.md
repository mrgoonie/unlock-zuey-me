# Re-review: PR #38 (fix/25-insights-review-findings)

- **Date:** 2026-10-27
- **Reviewer:** code-reviewer, fresh context, read-only on source.
- **Worktree:** `.claude/worktrees/agent-a5f04c7cc19539e64`, 10 commits on `origin/main`, 38 files, +1503/-368.
- **Source review:** `plans/reports/code-reviewer-261027-insights-and-17-24-review.md`.

## Verdict
**Clean.** No findings at Medium or above. Every claimed fix closes its finding, and no bypass path was found. There are 7 Low items below, all optional.

## Checks run
- `bun run test`: 82 files, 913/913 pass.
- `bun run build` (astro check + build): 0 errors, 0 warnings.
- `bun run migrations:check`: OK.
- Redaction probe (bun, scratch file outside the repo): false positives and timing on 9 adversarial inputs of 40-100 KB. Every input ran in under 2 ms, so there is no catastrophic backtracking.
- Copy-check benchmark (temporary test, deleted): a 6.7 KB body checked against 50 evidence items takes about 0.65 ms.
- The tree is clean after the review.

## Finding-by-finding verification

**H1: closed.**
- Only two places file an issue: `fileApproved` in the cron and the admin `file_issue` action. Both call `fileProposal` (`src/lib/insights/proposal-filing.ts`).
- `fileProposal` recomputes the draft (`currentDraft`) and the gate from the cohort that is consented now, over the 14-day window.
- `filingRefusal` blocks `none` and every evidence reason (`cohort_too_small`, `low_confidence` including the issue tier's 0.75, `personal_preference`, `privacy`) for operator and accepted paths too. Operator approval only replaces the risk tier.
- "Copy issue markdown" is a manual filing route. Its source, `proposalDetail`, also goes through `currentDraft`, so a withdrawn draft gives `issueMarkdown = null`.
- `approve_ai_handle` refuses when `issueMarkdown` is null.
- `withdrawProposalDraft` voids acceptance, the ai-handle approval and the lease.
- `evidenceStillConsented` relies on PK `(signal_id, report_id)`, so `COUNT(*) == unique.length` is exact.
- The stale-draft SQL and `currentDraft` use the same predicates, so `refreshStaleDrafts` cannot loop on a `keep`.
- Legacy drafts without `basis` are rebuilt from the template.

**H2: closed.**
- `PROPOSAL_MIN_COHORT = 3` for every category.
- `templateDraft` takes no evidence. Its only learner-derived field is `signal.title`, built by `signalTitle` from category, area and the normalised topic key.
- `buildDraft` sends at most 5 items and records them in `basis`.
- The copy check flags any shared run of 40 normalised characters or 8 words. It runs against up to 50 consented items in the window at creation, refresh, detail and filing.
- The consent copy (`InsightsSettingsPanel.tsx:100`) now matches what the code does.

**M1: closed.**
- When the lease has expired, `prior === 'filing'` triggers a marker search. If the issue is found it is linked; otherwise the proposal is released.
- Every non-filed outcome releases the lease or withdraws the draft. The only exception is an ambiguous POST, which deliberately keeps the lease.
- `updateProposalGate` now also covers `filing`.
- `fileApproved` selects only rows that can file.

**M2: closed.** No ReDoS:
- every quantifier is bounded;
- the `url_credentials` user part excludes `:`, so the split is deterministic.

Probe results:
- Ordinary Vietnamese text with numbers ("Năm 2025 … điểm 9.5, mã 100200300") is untouched.
- "Mật khẩu là gì?" is untouched.
- `https://host:8080/a@b` and `https://x.com/@user` are untouched.

There are minor over-redactions (L1).

**M3: closed for poll.** An unknown code returns `expired` before any KV write. `pair/start` remains (L2).

**M4: closed.**
- `ai_usage` has no FK on `learner_id`, so the `system:insights` row inserts fine.
- `readUsage` treats every non-`*` row as "learner". The global row math is unchanged: the global `*` row is still reserved in the same conditional UPDATE, with coach share applied.
- `ai_usage` is read only by `ai-usage.ts` and `ai-gateway.ts`, and touched by `learner-data-tables.ts` (deletion).
- There is no admin, learner or observer view of `ai_usage`, so the system row leaks nowhere.
- `UNCAPPED = 1e9` binds safely as a REAL in SQLite.

**M6: closed.** The backup is removed after a verified write or a successful rollback, and kept only when the rollback failed. Uninstall cleans leftover `.bak`/`.tmp` files next to the project files.

**Other fixes: closed.**
- Revoke counter: `completeWindow` re-reads consent and whether the events exist. It uses numbered params, and the id count is bounded the same way as the batch above it.
- Doctor MCP URL: the hint uses the configured origin.
- Migration rules: they match `qid_`, quoted and schema-qualified names, and keywords inside quotes cannot match because `_` is a word char.
- Push fallback: wrapped in try/catch.

## Critical / High / Medium
None.

## Low

**L1: the prose-password rule over-redacts capitalised words.**
- **Where:** `skills/ai-unlocked/scripts/lib/redact.mjs:104-109` (`looksLikePassword` mixed-case branch).
- **Probed:**
  - "Lỗi hiển thị: Password is Required" → `Password is [REDACTED:secret]`.
  - "The password is Wrong" → redacted.
  - "password was Changed by admin" → redacted.
  - The bank rule also catches "account number of steps: 12345678".
- **Impact:** a safe-direction loss of analyzer context, for example when a learner pastes an auth error message.
- **Fix:** drop the mixed-case branch, or require mixed case *and* length ≥ 6 with a non-initial capital/digit/symbol. Add the strings above as negative fixtures.

**L2: `pair/start` still makes 2 unauthenticated KV writes per request.**
- **Where:** `src/lib/insights/device-pairing.ts:88-89`, reached from `src/pages/api/ingest/v1/pair/start.ts`. It is IP rate-limited only.
- **Context:** the original M3 scenario mentioned this, but the fix covered poll only.
- **Fix (optional):** a lower per-IP limit for `pair/start` or a global daily pair-start counter. If not fixed, record it as accepted in #37.

**L3: the docs claim does not match the code on daily slots.**
- **Where:** `docs/insights-ingest-contract.md` ("Stuck rows never hold a daily slot") and the dev report ("Stuck rows take no daily slot").
- **The code says otherwise:** `proposal-filing.ts` keeps the slot reserved by an ambiguous create even after a later `released` ("stays counted (conservative)").
- **Fix:** reword it to "never hold a per-tick filing slot; an ambiguous create keeps its daily slot".

**L4: a `filing` row cannot be recovered while GitHub mode is `off`.**
- **Scenario:** an ambiguous create leaves the row in `filing`, then the operator sets `INSIGHTS_GITHUB_ISSUES=off`. From then on:
  - `fileApproved` does not run;
  - `refreshStaleDrafts` (`proposal-store.ts` `proposalsWithStaleDrafts`) and `evaluateSignals` skip `filing`;
  - `TRIAGE_TRANSITIONS` has no transition out of `filing`;
  - `file_issue` answers `github_off`.
- **Result:** the row and its stored `draft_json` stay as they are until the mode is turned back on.
- **Exposure:** none, because readers recompute.
- **Fix:** in `refreshStaleDrafts`, also take expired `filing` rows when the mode is off and release them (`releaseFiling`) before refreshing.

**L5: the ai-handle approval and acceptance survive a template replacement.**
- **Where:** `proposal-assessment.ts` `persistAssessment` → `updateProposalDraft`. It voids `ai_handle_approved_by` and `decided_by` only on withdrawal.
- **Scenario:** the operator approves ai-handle on AI draft X. One basis learner revokes while the cohort stays ≥ 3. Draft X is replaced by template Y, and Y is filed with the `ai-handle` label under the approval given for X.
- **Risk:** low, because the template is deterministic text.
- **Fix:** clear `ai_handle_approved_by` (and optionally reset `accepted` to `proposed`) when the draft text changes.

**L6: withdrawn proposals stay listed with the signal title and low counts.**
- **Where:** `listProposalSummaries`, `toProposalSummary` in `proposal-store.ts`.
- **What stays visible:** the proposal row, the signal title (whose topic tokens are model-derived from learner turns) and a cohort count of 0-2.
- **The gap:** the copy says a proposal "chỉ xuất hiện khi có từ 3 người học trở lên" ("only appears when 3 or more learners…").
- **Fix (optional):** filter or hide rows whose `draft_json = '{}'` and that have no issue, or show them as "đã rút" (withdrawn) without the title.

**L7: the revoke counter misses a partial deletion.**
- **Where:** `event-queue.ts` `completeWindow`.
- **Scenario:** if the learner deleted only some of the leased events mid-call (and consent stays on), `NOT EXISTS(any id)` is false, so the outcome is `lease_lost` rather than `revoked`.
- **Impact:** counter accuracy only.
- **Fix:** compare `COUNT(*)` with `ids.length`.

## Regressions
- None found.
- The admin UI handles `draft: null` (`ProposalDetail.tsx`).
- The `FilingOutcome` union gained `released`, which is mapped in the API error table.
- The `templateDraft` and `consentedEvidence` signature changes are internal, and every caller was updated (grep-verified).

## Unresolved questions
1. Should L2 (`pair/start` writes) be recorded under #37 as accepted?
2. Is a proposal row with a withdrawn draft staying in the dashboard list (L6) acceptable against the consent copy?
