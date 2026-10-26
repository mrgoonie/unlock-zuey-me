# Deployment and database migrations

Production (https://unlock.zuey.me) is deployed by `.github/workflows/deploy.yml` on every push to `main`. Nobody deploys by hand.

## Deploy order

1. Gates: `content:check`, `migrations:check`, `test`, `build`. The same gates run on every PR in `.github/workflows/ci.yml`.
2. Record a D1 Time Travel bookmark. This is the rollback point, and it is written to the job log and the run summary.
3. `wrangler d1 migrations apply unlock_zuey_me_db --remote`
4. `wrangler deploy`
5. Sync secrets, run the `/api/health` smoke check, then run production E2E.

Between steps 3 and 4 the **previous worker is still serving traffic on the new schema**. The same holds if step 4 fails or is rolled back. So the order alone does not keep production safe. The rule below does.

## Rule: every migration must work with the previous worker (expand/contract)

A migration may only **expand** the schema in ways the worker currently in production ignores:

- new tables;
- new columns that are nullable or have a `DEFAULT` (the old worker's `INSERT`s must still succeed);
- new non-unique indexes;
- plain `INSERT`s of seed or reference data.

Any change that is **destructive or changes meaning** is split across two releases:

| Change | Release 1 (expand) | Release 2 (contract, after release 1 is live everywhere) |
|---|---|---|
| Drop a column/table | Stop reading and writing it in code | `DROP` it |
| Rename a column | Add the new column, write both, read the new one (backfill if needed) | Drop the old column |
| Tighten a constraint (unique index, trigger) | Make the code never violate it and clean up existing rows | Add the constraint |
| Backfill / rewrite rows | Ship code that handles both old and new values | Run the `UPDATE` |

`bun run migrations:check` (`scripts/check-migrations.ts`, rules in `scripts/migration-safety-rules.ts`) enforces this rule in CI and before the deploy migrates. It rejects these statements in any migration newer than `0006`:

- `DROP TABLE/VIEW/INDEX/TRIGGER`, `ALTER TABLE ... DROP`, `ALTER TABLE ... RENAME`;
- `UPDATE`, `DELETE`, `REPLACE`, `INSERT OR REPLACE`;
- `CREATE UNIQUE INDEX` and `CREATE TRIGGER` on a table that the same file does not create.

The contract step of a two-release change, or a data change that is known to be safe, must say so in a comment right before the statement. The comment names the kind and gives a reason:

```sql
-- migration-allow: destructive legacy_score unused since the 2026-11-02 release
ALTER TABLE learners DROP COLUMN legacy_score;
```

The kinds are `destructive`, `data-change` and `constraint`. Reviewers check that the reason is true. Migrations `0001`–`0006` were applied before the guard existed and are not checked. `0004` is an example of what the guard now catches: it rewrites rows and adds a unique index.

## Rollback

- **Worker:** `wrangler rollback` (or redeploy an earlier commit). This is safe because every migration is backward compatible.
- **Database:** use D1 Time Travel only when a migration damaged data. Restoring rewinds **all** writes made since the bookmark, so learner progress made since then is lost.

  ```bash
  bunx wrangler d1 time-travel restore unlock_zuey_me_db --bookmark=<bookmark from the deploy run summary>
  # or by time (within the last 30 days):
  bunx wrangler d1 time-travel restore unlock_zuey_me_db --timestamp=2026-10-26T15:00:00Z
  ```

  A restore also rewinds the `d1_migrations` table, so the next deploy applies the reverted migrations again. Fix or revert the bad migration on `main` before anything else merges.

## Running migrations locally

```bash
bun run migrations:check   # the same guard CI runs
bun run db:migrate:local   # applies migrations/ to the local D1 used by `bun run dev` / `bun run preview`
bun run test               # unit tests load every migration into an in-memory SQLite (tests/helpers/d1-sqlite.ts)
```

To add a migration, create the next numbered file, for example `migrations/0007_short_name.sql` (four digits, lowercase snake case). Never edit a migration that is already on `main`. `bun run db:migrate:remote` exists for emergencies only. Normal changes reach production through the deploy workflow.
