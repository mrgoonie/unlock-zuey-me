# Insights review fixes (#25)

Source review: [code-reviewer-261027-insights-and-17-24-review.md](code-reviewer-261027-insights-and-17-24-review.md). Branch `fix/25-insights-review-findings`. No production change, no deploy, no secrets.

## Fixes

| Finding | Fix | Regression test |
|---|---|---|
| H1 stale draft filed after consent loss | Every filing path (cron, accepted, operator) recomputes the consented cohort and gate before filing (`proposal-filing.ts`, `proposal-assessment.ts`). Drafts record `basis` report ids; a draft whose basis lost consent is rebuilt from the template, and below 3 learners it is withdrawn (`draft_json='{}'`, back to `proposed`). Operator/accepted override only the risk tier, never the evidence gate. Cron refreshes stale drafts of open, rejected and duplicate proposals. Detail view shows a withdrawn notice. | `insights-proposal-consent-withdrawal.test.ts` (revoke / delete reports / delete account → neither cron nor operator files, draft cleared; mutation-checked against old logic) |
| H2 cohort 2 and quoted evidence | `PROPOSAL_MIN_COHORT = 3` for every category. Template has no quotes; prompt forbids copying; `issue-privacy-check.ts` rejects a 40-char normalized run or 8-word overlap, and the model draft is replaced by the template. Settings copy already said 3; not changed. | `insights-issue-draft-privacy.test.ts`, `insights-policy-gate.test.ts`, `insights-proposal-stage.test.ts` |
| M1 stuck `filing` | An expired lease first searches GitHub for the marker and links it, otherwise releases to `accepted`/`proposed` (`released` outcome). Stuck rows take no daily slot. | withdrawal suite: ambiguous create → linked; released then files once; stuck rows do not starve slots |
| M2 redaction gaps | `redact.mjs`: `url_credentials`, prose passwords (EN/VI), `bank_account` (labelled), `stripe_key`, `azure_key`. Manifest hashes are computed at build time, so nothing was pinned. | `insights-redaction.test.ts` (positives, negatives, timing) |
| M3 KV write on unknown device code | `pollPairing` reads the record first; unknown code returns `expired` with no write. | `insights-ingest-device-pairing.test.ts` |
| M4 analyzer used learner's coaching share | `usageScope`: purpose `insights` charges `system:insights` in the coaching pool, per-learner caps lifted; global caps and insights quotas still apply. Documented in `docs/insights-rollout.md`. | `insights-ai-budget.test.ts` (charges on system row; learner with spent share still analysed; hints unaffected) |
| M6 `.ai-unlocked.bak` left in project | Backup removed after a verified write or a successful rollback; kept only when rollback fails. `hook uninstall --scope project|all` and `uninstall` delete leftover `*.ai-unlocked.bak`/`.tmp` next to project settings. Docs: `hook-lifecycle.md`, `insights-rollout.md`. | `skill-settings-merge.test.ts`, `skill-cli-lifecycle.test.ts` |
| (a) revoked counted as lost lease | `completeWindow` reports `revoked` when consent is gone or the window's events were deleted (the consent switch purges them itself). | `insights-analyzer-stage.test.ts` (consent switch, delete-all mid-call) |
| (b) doctor hardcoded production MCP URL | `mcpAddCommand(serverOrigin)` from credentials / `AI_UNLOCKED_SERVER`; an MCP entry pointing at the configured origin counts as configured. | `skill-cli-lifecycle.test.ts` |
| L5 quoted table names | Quoted identifiers become `qid_<name>` words; unique-index/trigger rules match quoted and schema-qualified names. | `migration-safety-check.test.ts` |
| L9 reminder fallback batch | Fallback state-write failure is logged and the run continues (rows stay claimed, no double send). | `push-reminder-job.test.ts` |

## Verification
- `bun run test`: 913/913 pass (82 files).
- `bun run content:check`, `bun run migrations:check`: OK.
- `bun run build` (astro check + build): 0 errors, 0 warnings.

## Notes
- Legacy stored drafts without `basis` are treated as stale and rebuilt from the template on the next assessment.
- Other Lows (L1-L4, L6-L8) left as is, per scope.

## Unresolved questions
- None.
