# ai-tutor insights: rollout, evaluation gate and manual QA

Operator runbook for turning on the ai-tutor insights feature (issue #25). Flags and wire contract: [insights-ingest-contract.md](insights-ingest-contract.md). Routes: [api-contract.md](api-contract.md#ai-tutor-insights-owner-insights-module-issue-25). Deploy mechanics and migration rules: [deployment.md](deployment.md).

Production runs **`on`** since 2026-10-27 (`INSIGHTS_MODE` in `wrangler.jsonc`): every zuey.me member, GitHub issues off. The owner chose to skip the one-week `internal` and the `pilot` steps below so the first real learner can start; the cohort and quota hardening in issue #37 matters more now that any member can pair a device. Every flag is a wrangler var: change it in `wrangler.jsonc` through a PR (the deploy workflow applies it) or in the Cloudflare dashboard for an urgent change, then mirror the dashboard edit in `wrangler.jsonc` so the next deploy does not undo it.

## Rollout checklist

1. **Merge with `INSIGHTS_MODE=off`.** The deploy applies migration `0008_insights.sql` (new tables only, safe with the previous worker). Check `/api/health`, and that production E2E (`e2e/insights.spec.ts`) is green: every insights page, API and `/skill` file is a 404, and Settings has no `s-insights` section.
2. **`internal` (admins) for one week.** Watch on `/admin/insights`:
   - pipeline health: dead-letter count (target 0), failed and budget-deferred windows;
   - useful-rate of reports marked by admins ("Hữu ích" / "Không hữu ích"), target ≥ 60 %;
   - AI spend: the `system:insights` row of `ai_usage`. The background analyzer reserves in the global coaching pool (so grading is never starved) but is charged to this system row, never to the learner's own per-learner coaching share: an analysis cannot use up a learner's hints and chat for the day. It stays bounded by the global daily caps (USD and Workers AI) and the insights quotas (per-learner and global daily analyses).
3. **`pilot`** with `INSIGHTS_PILOT_EMAILS` (comma-separated). Pilot learners still opt in themselves: install, pair and consent are separate steps.
4. **GitHub issues**, only after the evaluation gate below passes: create a fine-grained PAT (Issues: write on `INSIGHTS_GITHUB_REPO` only, 90-day rotation), `wrangler secret put GITHUB_ISSUES_TOKEN`, set `INSIGHTS_GITHUB_ISSUES=issues`. Even then nothing is filed automatically: each issue needs an operator's "Tạo issue GitHub" click on `/admin/insights/proposals`. Later, and only deliberately, `issues_ai_handle` plus the operator toggle `safe_auto_implement` (typed confirm `BAT`), which only decides whether an operator-filed issue may carry `ai-handle`.
5. **`on`** (all members).

### Evaluation gate for GitHub issues

Keep `INSIGHTS_GITHUB_ISSUES=off` until at least **20 proposals** have been reviewed by an operator on `/admin/insights/proposals` and **fewer than 10 %** of them were rejected as "not a general platform issue". Until then the dashboard plus "Sao chép nội dung issue" is the only path to GitHub.

### First tick after the issue #37 deploy

Proposal cohorts now count only established learners: a member whose account was at least 7 days old when the report was written, with at least one completed mission before it. After the deploy the cron re-checks open drafts under this rule over the next ticks (10 drafts per tick), while hiding proposals with a too-small cohort applies at once because it is checked on every read. Proposals supported mostly by newer accounts get the template text back or are withdrawn, which clears their acceptance and any ai-handle approval, and proposals whose cohort drops below 3 without an issue disappear from `/admin/insights/proposals`. This is intended. The product signals on `/admin/insights` use the same rule. Learners who held more than 10 device tokens before the deploy keep them until their next pairing, which revokes the oldest.

## Rollback

- `INSIGHTS_MODE=off`: every route 404s, the UI hides, the cron stage stops. Tables stay, inert.
- `INSIGHTS_GITHUB_ISSUES=off` or `wrangler secret delete GITHUB_ISSUES_TOKEN`: issue filing stops at once. A filing interrupted mid-way returns to `proposed`/`accepted` at the next tick once its 2-minute lease expires; its fingerprint claim stays, so turning GitHub back on links the issue it may have made instead of filing a second one.
- On learner machines, `ai-unlocked uninstall [--purge]` removes only its own hook entries, plus any `*.ai-unlocked.bak` / `*.ai-unlocked.tmp` an older CLI left next to the project settings files. The current CLI deletes its settings backup as soon as a write is verified and keeps it only when a rollback failed. While the flag is off the hook gets 404, drops its spool and backs off for 24 h.
- No down-migration; `0008` and `0010` (`insight_issue_filings`) are additive and unreferenced by older code.

## Manual QA (local preview)

Member flows cannot run in production E2E. They are covered by `tests/unit/insights-end-to-end-pipeline.test.ts` (consent → pairing → ingest → analyzer → reports → proposals → operator summary, mock AI) and by this script, run by a person with a zuey.me admin account and Claude Code. Record the results, including the hook timing, in the PR.

1. `bun run db:migrate:local`, then `bun run build` and start the preview with the feature on:
   `bunx wrangler dev --port 8787 --var INSIGHTS_MODE:internal` (or put `INSIGHTS_MODE=internal` in `.dev.vars`). Sign in as an admin member.
2. In a scratch project, let Claude Code run `curl -fsSL http://localhost:8787/skill/install.mjs | node - --scope project --server http://localhost:8787`, then `ai-unlocked hook install --scope project`. Export `AI_UNLOCKED_SERVER=http://localhost:8787` for every CLI command (pairing and uploads use it; only loopback may use http). Diff `.claude/settings.local.json` before and after: one marker entry added, foreign hooks untouched.
3. `ai-unlocked pair`, approve the code on `/insights/pair`, run three learning turns that use the MCP tools, then trigger the cron (`wrangler dev --test-scheduled`, `curl "http://localhost:8787/__scheduled"`) after the 5-minute debounce. The report appears on `/insights` (`data-testid="insight-report"`).
4. Turn analysis off in Settings, run another turn: no new row in `insight_events` (`bunx wrangler d1 execute unlock_zuey_me_db --local --command "SELECT COUNT(*) FROM insight_events"`), and `ai-unlocked doctor` reports that the server refuses the device because analysis consent is off.
5. `ai-unlocked uninstall --purge`: the settings file is back to the original (byte-identical when it was 2-space JSON; other formatting is normalised, content deep-equal), and the device shows as revoked in Settings.
6. Time 20 turns of the hook (`time`), and record p95 in the PR.

E2E: `e2e/insights.spec.ts` picks its block from `INSIGHTS_MODE` in `wrangler.jsonc`, so production E2E checks whatever the deploy ships. Against a preview started with another `--var`, set `E2E_INSIGHTS=1` (feature on) or `E2E_INSIGHTS=0` (off): `E2E_BASE_URL=http://localhost:8787 E2E_INSIGHTS=1 bunx playwright test e2e/insights.spec.ts`. With the feature on it checks the guest sign-in CTA on `/insights/pair`, the `/skill` manifest hashes against the served files, that member pages and APIs stay 404 for a guest, and that ingest rejects an unknown token with 401.
