# Deploy order guard (#18) and cron budget (#23)

Branch `fix/deploy-order-and-cron-budget`. Status: done; all gates are green locally.

## #18 Deploy window

- `docs/deployment.md` (new) covers the deploy order, the expand/contract rule with a two-release table, the `migration-allow` marker, rollback (worker rollback and D1 Time Travel restore, plus its caveats), and local migration commands. It is linked from `README.md`.
- `scripts/migration-safety-rules.ts` holds the pure rules and `scripts/check-migrations.ts` is the CLI, run as `bun run migrations:check`. The checker strips comments and string contents and keeps trigger bodies as one statement. It rejects:
  - `destructive`: `DROP`, `ALTER ... DROP`, `ALTER ... RENAME`.
  - `data-change`: `UPDATE`, `DELETE`, `REPLACE`, `INSERT OR REPLACE`.
  - `constraint`: a unique index or trigger on a table the same file does not create.

  Each rejected statement must be preceded by `-- migration-allow: <kind> <reason>`, and the reason must be at least 10 characters. Migrations 0001–0006 are grandfathered (`GRANDFATHERED_THROUGH = 6`). The checker also rejects badly named or duplicate-numbered files.
- `ci.yml` and `deploy.yml` run the gate. `deploy.yml` also records a bookmark with `wrangler d1 time-travel info --json` into the log and step summary before migrating, and fails closed if it can't read a bookmark. Only the bookmark, a timestamp and the SHA are printed; no secrets.
- The pipeline order is unchanged (migrate, then deploy), as requested. No production, secrets or Cloudflare resources were touched.

## #23 Cron budget

- Limits verified on 2026-10-26 and cited in `src/lib/jobs/cron-budget.ts`:
  - D1 allows 1,000 queries per invocation on Workers Paid, and a batch counts as 1 (https://developers.cloudflare.com/d1/platform/limits/).
  - Workers allow 10,000 subrequests per invocation on Paid, and fetch, KV, R2 and D1 all count (https://developers.cloudflare.com/workers/platform/limits/).
- The budget now tracks `d1` (900) and subrequests (9,000, D1 included) separately and exposes `canAfford`. `reserving()` gives a job a view with a slice held back while charges still land on the shared budget.
- Push reminders:
  - The open mission is read inside the due query.
  - Each chunk of 6 sends costs one claim query (`UPDATE ... RETURNING`) and one `db.batch` that holds the result writes and events. That is about 0.35 D1 per send plus 1 subrequest per push. Before, every send cost 5 units.
  - The job charges as it goes and checks `canAfford` before every chunk. Rows it read but did not claim stay due for the look-back.
  - If the event writes fail, the state writes are retried on their own.
- `CLEANUP_RESERVE` holds back 100 D1 queries, 1,000 subrequests and 60 s from push reminders. OAuth purge, guest cleanup and evidence GC now charge D1 and network costs separately and check `canAfford` before each step.
- Throughput: `MAX_SENDS_PER_RUN` (1,000) is now the binding limit. 1,000 sends use about 350 D1 queries and 1,350 subrequests.

## Tests

- New `jobs-cron-budget.test.ts` covers the budget math, `canAfford`, exhaustion and the reserve view.
- `jobs-scheduled-dispatch.test.ts` checks the push view excludes the reserve and that cleanup jobs still run after a greedy push.
- `push-reminder-job.test.ts`:
  - exact D1 and subrequest charges;
  - 600 sends in one tick;
  - stops under both limits;
  - a carry-over to the next tick inside the 60-minute look-back;
  - the event-failure fallback.
- `jobs-cleanup.test.ts` adds D1-limited cases.
- `migration-safety-check.test.ts` (25 cases) covers:
  - each rule;
  - comments, strings and triggers;
  - markers, including wrong kind and missing reason;
  - the baseline;
  - the real repository passing;
  - 0004 being flagged when the baseline is not applied.
- `content:check`, `migrations:check`, `test` (417 passed) and `build` (0 errors) all pass.

## Deviations / notes

- `docs/api-contract.md` is outside my file list. I updated one line in it because it described the old single budget and would otherwise be wrong.
- `reminder-job.ts` writes the `events` INSERT inline, with the same row shape as `recordEvent`, so the events go into the chunk batch. `src/lib/observer/events.ts` is not in my file list. A future cleanup could export a statement builder from there to remove the duplicate.

## Unresolved questions

- The bookmark step fails the deploy when wrangler's `--json` output can't be parsed (for example, if a warning appears on stdout). That is fail-closed by design. Should it warn instead?
- The `constraint` rule (unique index or trigger on an existing table) goes beyond the issue's list. I added it because migration 0004's unique index is exactly the case #18 describes.
