# Code review: bdccc2b..HEAD (#17, #18, #21, #23, #24, #25)

Date: 2026-10-27. Reviewer: code-reviewer, fresh context, read-only. No source files were changed. Scratch probe tests were written to `tests/unit/__scratch_review/` to verify findings and then deleted.

## Scope
- Range: `bdccc2b..HEAD` on main (HEAD 9c22ccb).
- Focus areas:
  - insights (#25): migration 0008, `src/lib/insights/**`, admin and learner APIs, the `/skill` bundle, and `skills/ai-unlocked/scripts/**`;
  - abandon run (#17);
  - migration guard and D1 bookmark (#18);
  - per-learner coach share and QuizSteps a11y (#21);
  - cron budget and push reminders (#23);
  - runner draft and autosave (#24).
- Checks run:
  - `bun run test`: 81 files and 865 tests, all pass.
  - `astro check`: 0 errors.
  - `migrations:check`: OK.
- Scout notes:
  - Consent revocation does not purge derived proposal drafts.
  - The operator and accepted filing paths ignore the cohort gate.
  - A `filing` state can get stuck.
  - Redaction misses some patterns.
  - KV writes happen before the existence check.
  - The insights analyzer now draws on the learner's own coaching share.

## Overall assessment
The structure is solid:
- Consent is re-checked inside SQL on ingest, in `completeWindow`, and in the evidence joins.
- Tokens are stored hashed.
- Leases are guarded by `lease_id`.
- Admin routes return 404 when the flag is off.
- The hook never blocks.
- The installer verifies sha256.

The weak spot is the **proposal/issue path after consent changes**:
- Proposal text (`draft_json`) is built once and never invalidated.
- Operator or accepted filing bypasses the cohort and confidence gate.

Together these let content derived from revoked or deleted learner data reach a **public** GitHub repo (`mrgoonie/unlock-zuey-me` is public). The consent copy also over-promises compared with the code (it says ≥3 learners; the code allows 2).

## Critical / High

### H1 (High, privacy; Critical if GitHub issues are on): issues filed after every contributor revoked consent, using a stale draft
- **Where:** `src/lib/insights/proposal-stage.ts` ~306-316 (`operatorApproved = opts.operator || p.status==='accepted' || (p.status==='filing' && p.decided_by!==null)`). The gate only blocks privacy hits and the daily cap. The `fileApproved` query is at ~365-370.
- **Where the stale draft comes from:** `draft_json` is written once in `evaluateSignals`. `consent-store.ts` (proposals revoke), `learner-report-queries.ts` `deleteAllReports`, and the account delete path (`src/lib/privacy/learner-data-tables.ts`) never touch `insight_proposals.draft_json`.
- **Scenario:** verified with a vitest probe.
  1. Three learners contribute and a proposal is created.
  2. The operator accepts it, or it waits as `accepted` until the issue mode is turned on.
  3. All three learners turn off `proposals` consent, or delete their reports or account. Cohort drops to 0 and the gate becomes `none` with `[cohort_too_small, low_confidence]`.
  4. The `fileProposal(..., {operator:true})` probe returned `filed`. The cron's `fileApproved` also filed the `accepted` proposal (`filed=1`).
  5. The body says "0 learners" but contains the problem, evidence and acceptance text derived from the revoked evidence (template quotes up to 160 chars each).
  6. `proposalDetail` also keeps showing that draft to operators.
- **Impact:**
  - Breaks the consent promise ("Đã tắt. Báo cáo của bạn không còn được dùng cho đề xuất." / "Turned off. Your reports are no longer used for proposals.").
  - Breaks the deletion promise: derived text survives erasure.
  - The text is published to a public repo, which cannot be revoked once indexed.
- **Fix:**
  1. In `fileProposal`, require `gate.decision ∈ {issue}` (at least proposal tier, plus `cohort ≥ ISSUE_MIN_COHORT`) for **every** path, including operator and accepted. The operator can only override the risk tier, not the cohort or confidence.
  2. Rebuild the draft from currently consented evidence right before filing and in `proposalDetail`. If the cohort is below the minimum, show and file nothing.
  3. When evidence drops (consent revoke, report delete, account delete, retention), either clear `draft_json` and set the gate to `none`, or delete proposals whose consented cohort is 0.
  4. Add a test: revoke all, then operator file must return `not_allowed`.
  5. Fix `docs/insights-ingest-contract.md:155` so the doc describes the actual rule.

### H2 (High, consent accuracy): copy promises ≥3 learners and no quotes; code uses a cohort of 2 and quotes evidence
- **Where:**
  - `src/components/settings/InsightsSettingsPanel.tsx:99-101`: "…không trích lời bạn. Một đề xuất chỉ xuất hiện khi có từ 3 người học trở lên…" ("…never quoting you. A proposal only appears when 3 or more learners…").
  - `src/lib/insights/proposal-policy-gate.ts`: `PROPOSAL_MIN_COHORT` is bug 2, content 2.
  - `src/lib/insights/issue-draft.ts`: `templateDraft` quotes up to 3 `abstract_evidence` items (≤160 chars), while the `privacyCheck` `VERBATIM_RUN=200` can never match a ≤160-char quote.
- **Scenario:** verified. 2 learners produced a proposal that operators can see, with each learner's model-written evidence quoted. Nothing but a prompt instruction stops `abstract_evidence` or `product_observation.summary` from paraphrasing or quoting the learner closely.
- **Fix:**
  - Pick one. Either raise `PROPOSAL_MIN_COHORT` to 3 for every category, or change the copy to "từ 2 người học (lỗi/nội dung)" ("from 2 learners (bugs/content)").
  - Lower `VERBATIM_RUN` below `EVIDENCE_QUOTE_MAX` (e.g. 60), or check each quote against the source turn text.
  - Soften "không trích lời bạn" (never quoting you) to match the guarantee the code actually gives.

## Medium

### M1: a proposal in `filing` gets stuck and starves filing slots
- **Where:**
  - `proposal-stage.ts` `fileProposal`: the not_allowed/privacy/daily_cap returns do not release the lease and do not run the marker search first.
  - `proposal-store.ts` `updateProposalGate`: only `status IN ('proposed','accepted')`.
- **Scenario:** verified by a probe.
  1. Create returns a 5xx or a network error, so the row stays `filing`.
  2. Later the gate drops, so `fileProposal` returns `not_allowed`. The row stays `filing` with an unchanged `updated_at`.
  3. Every tick re-selects it (expired lease), and it takes 1 of the 3 per-tick filing slots.
  4. Three such rows block all filing.
  5. If the ambiguous create actually succeeded, the issue is never linked.
- **Fix:**
  - For `filing` rows, always run the fingerprint marker search first and link if found.
  - On any non-filed outcome, call `releaseFiling` (back to `accepted`/`proposed`).
  - Let `updateProposalGate` also cover `filing`.

### M2: redaction gaps (client `skills/ai-unlocked/scripts/redact.mjs`, shared with the server)
Probed misses:
- URL userinfo:
  - `postgres://admin:Sup3rS3cret@localhost:5432/app`
  - `https://user:Passw0rd!@example.com/x`
  - `redis://:pass@10.0.0.5`
- Prose passwords: "my password is hunter2", "mật khẩu là Abc@12345" ("my password is Abc@12345").
- Vietnamese bank account numbers ("STK 19036789012345").
- Stripe `rk_live_…`.
- Azure `AccountKey=…==` / connection strings.

These go to the server, the LLM, and possibly operator views.

**Fix:**
- Add rules for:
  - `scheme://[^/\s:@]*:[^@\s]+@`;
  - labelled password, `mật khẩu` (password) and `pass`;
  - labelled `STK|số tài khoản|account no` (account number) followed by 8-19 digits;
  - `rk_(live|test)_`;
  - `AccountKey=[A-Za-z0-9+/=]{20,}`.
- Add the probe strings above as fixtures.

### M3: `pair/poll` writes to KV before checking that the device code exists
- **Where:** `src/lib/insights/device-pairing.ts:147-151`.
- **Scenario:** an unauthenticated client polls random device codes. Each poll does a `kv.put` (rate limited only by `RL_WRITE_IP` at 120/min/IP). `pair/start` does 2 puts per request. Distributed IPs can burn the KV write quota: 1k/day on the free plan, billed per write on paid.
- **Fix:** read the record first and return `expired_token` without writing. Write the poll-interval key only for existing records.

### M4: the insights analyzer consumes the learner's own coaching (hint/chat) budget
- **Where:**
  - `src/lib/insights/analyzer-stage.ts:169-171` (`purpose:'insights'`, `learnerId: win.learnerId`);
  - `src/lib/coach/ai-gateway.ts` `budgetPool` sends insights to `coaching`;
  - `src/lib/coach/ai-usage.ts` reserve SQL now caps per-learner coaching at `perLearnerUsd × share` (default $0.15/day) and `floor(WORKERS_AI_PER_LEARNER × share)` calls.
- **Scenario:** a learner with analysis on can get up to 12 background analyses per day. Each one reserves from the same per-learner coaching share as their hints and practice chat, so:
  - heavy Claude Code days silently exhaust the learner's hints in the web runner;
  - or busy hint usage leads to analyses being budget-deferred.
- Not documented. `docs/insights-rollout.md` says only that grading is not starved.
- **Fix:** do one of the following:
  - charge insights to a system/global-only actor (like `SYSTEM_ACTOR` used by `issue-draft.ts:74`) with its own global sub-share;
  - or document this explicitly and show it in the consent copy.

### M5: prompt injection / sybil into public issues
- **Scenario:** an attacker creates 2-3 cheap member accounts with proposals consent and seeds the same `product_observation`, which is model-written from attacker-controlled turns. The result is a proposal and an auto-filed issue on the public repo. With `issues_ai_handle` plus `safe_auto_implement`, the issue routes to automated implementation.
- **Existing defenses:** the risk denylist, the URL check, `safe_auto` defaulting to off, and an AI-handle confirm on the operator path. These do not stop text injection into the issue body read by a downstream agent.
- **Fix:**
  - Require operator approval for every auto-file while the cohort is below some N.
  - Require account tenure or activity (e.g. ≥1 completed mission, account older than 7 days) for a learner to count toward the cohort.
  - Never auto-route AI-handle without a per-issue operator approval.
  - Fence the body as untrusted data for the downstream agent.

### M6: installer leaves `.claude/settings.local.json.ai-unlocked.bak` in the project
- **Where:** `skills/ai-unlocked/scripts/settings-merge.mjs` `applyToFile`.
- **Scenario:** project-scope install writes a permanent backup next to `settings.local.json`. The original file is normally gitignored by Claude Code convention, but the `.bak` name is not. It can be committed together with any env, keys or permissions in local settings.
- **Fix:** delete the backup after a successful write and verification, or write it under `~/.ai-unlocked/backups/`.

## Low
- **L1:** `insights-quotas.ts` counts the per-learner daily analyses from `insight_reports`, so `deleteAllReports` / `deleteReport` resets the learner's quota. This is bounded by the global 200 and the USD caps. Fix: count from `insight_events` processed today, or keep a daily counter.
- **L2:** `ingest-tokens.ts` `listTokens` has `LIMIT 50` (~line 104). Tokens beyond 50 cannot be seen or revoked in the UI, and there is no cap on minting. Fix: cap active tokens per learner (e.g. 10, revoking the oldest) or paginate.
- **L3:** `event-queue.ts` `claimWindow` uses the frozen stage `now`, so the lease ends at tickStart+5min. The 8th window (about 40s × 7 later) gets a short effective lease, which can cause a double-processing race with the next tick. It is guarded by `lease_id`, so only wasted AI spend results. Fix: compute the lease from `Date.now()`.
- **L4:** `operator-insight-queries.ts` `productSignals` joins `c.proposals=1` without `created_at >= proposals_at`, unlike `CONSENTED_EVIDENCE`. Counts can include pre-consent evidence. Aggregate only.
- **L5:** `scripts/migration-safety-rules.ts` blanks quoted identifiers to `"x"`, so `CREATE UNIQUE INDEX … ON "existing_table"` and `CREATE TRIGGER … ON "t"` escape the `\w+` match. Fix: match quoted identifiers too.
- **L6:** the migration numbering skips `0007`. Wrangler applies by name, so this is harmless, but `check-migrations.ts` does not flag gaps. Confirm it is intentional.
- **L7:** `flush-runner.mjs` blocks for 24h on 403. After a learner re-enables consent, uploads stay off for up to 24h with no CLI hint other than `doctor`. Fix: `pair`/`doctor` should clear the back-off.
- **L8:** GitHub search index lag after an ambiguous create can produce a duplicate issue despite the marker search. Fix: also list recent issues by label and creation time, without relying on search alone.
- **L9:** `src/lib/push/reminder-job.ts` `deliverChunk`: if the fallback `db.batch(writes)` also throws, the error escapes after pushes were sent. Rows stay claimed, so there is no double send, but failure counters and the rest of the run are lost. Wrap it and continue.

## Edge cases checked: OK
- Ingest:
  - `guardIngestRequest` order: flag 404, then Origin 403, then the IP rate limit.
  - The learner always comes from the token.
  - The INSERT re-checks analysis consent and the global cap in SQL.
  - The server re-runs `sanitizeTurn`.
- Consent:
  - The UPSERT enforces that share/proposals require analysis.
  - Revoking analysis deletes pending/processing events in the same batch.
  - `completeWindow` INSERT is consent-guarded.
- Operator drill-down requires observer_consent, share_operator and analysis, and is audited.
- The k≥3 rule (`COHORT_MIN`) applies to patterns and signals.
- Admin routes return 404 for non-admins and when the flag is off.
- The token never appears in any response (test plus read).
- Skill:
  - `normalizeServer` allows only https or loopback.
  - `redirect:'error'`.
  - Credentials are 0600.
  - The hook always exits 0 with a 1.5s deadline (p95 test passes).
  - The installer verifies sha256 and guards against path traversal.
  - The hook command quoting is safe.
- #17:
  - `abandon-run.ts` is rev-guarded with retries and refuses while evaluating.
  - `finalize-evaluation.ts:59` requires `status='evaluating' AND rev`, so a late finalize after abandon is a no-op.
- #21:
  - Per-learner coach share is added symmetrically in the USD and Workers AI reserve SQL.
  - `exceededScope` attribution is correct.
- #23:
  - Budget pre-checks happen before each batch and chunk.
  - The chunk claim uses `RETURNING`, so overlapping runs never double send.
  - Unclaimed rows stay due.
- #24:
  - `parseStoredDraft` validates untrusted localStorage, drops dirty flags that have no value, and removes unusable drafts.
  - `reloadStep` discards only the locked step's edits and leaves state intact on fetch failure.

## Recommended actions (priority)
1. H1: gate every filing path on the current consented cohort, rebuild or purge `draft_json` on evidence loss, and add a test. Fix this before any `INSIGHTS_GITHUB_ISSUES` value other than `off`.
2. H2: align the cohort minimum or the copy, and tighten the verbatim check.
3. M1: handle the stuck filing state.
4. M3: fix the KV write order.
5. M2: add the redaction rules.
6. M4: decide which budget insights are charged to.
7. M5: sybil and tenure policy before `on` and `issues_ai_handle`.
8. M6: clean up the `.bak` backup.
9. Low items as convenient.

## Plan status
#17, #18, #21, #23, #24 and #25 appear functionally complete, and tests are green. #25 should not move past `internal` with GitHub issues enabled until H1, H2 and M1 are fixed.

## Metrics
- Tests: 865/865 pass (81 files).
- Typecheck (`astro check`): 0 errors, 0 warnings.
- Migration guard: OK.
- Coverage: not measured.

## Unresolved questions
1. Is `.bookmark` the right key in `wrangler d1 time-travel info --json` (`deploy.yml`)? Cloudflare docs do not document the JSON shape. If wrong, the step fails closed and blocks deploys. Verify once with a manual run. Also note in docs that a restore overwrites every write made after the bookmark.
2. Is a cohort of 2 for bug/content intended? If so, the consent copy must change (H2).
3. #17: is reveal → abandon → retry (see answers, then restart clean) acceptable gaming?
4. Which KV plan is in use? It sets the severity of M3.
5. Should insights spend the learner's own coaching share (M4)?
