# Autosave lock signal, reveal-aware restore, run_hints export, cron budget

Part of #1. Branch `fix/autosave-lock-signal`.

## Changes

- **M1 (data loss).** The engine still throws `RevealedAnswerLockedError` with code `forbidden` (MCP unchanged), but `/api/v1` now serializes it as `403 { error: { code: "answer_locked" }, run }` (`src/lib/learning/errors.ts` `ANSWER_LOCKED_CODE`, `src/pages/api/v1/_route-helpers.ts`). The client knows `answer_locked` (`src/lib/ui/api-client.ts`). `src/lib/ui/autosave-queue.ts` runs lock recovery only for that code, HTTP 403, and a valid `run` for the same run id in the body. It restores only the fields locked by `run.revealed` (at most 2 recoveries per step per drain). The whole-step reset and the refetch fallback are removed. Any other 403, including a non-JSON one, keeps all edits dirty, sets state `offline`, and shows the neutral `SAVE_REFUSED_NOTICE`.
- **L1.** `restoreDraft` (`src/lib/ui/run-draft.ts`) drops local dirty flags for fields locked by the server's `revealed` (via `reveal-keys.ts`), so the server value wins.
- **L2.** `run_hints` is exported through the learner's runs (learner and merged guests) with a `mission_runs` subquery. It uses the same rowid paging and continuation (`RUN_OWNED_TABLES` in `learner-data-tables.ts`). Delete paths rely on the existing `ON DELETE CASCADE`, which a test now asserts.
- **L3/L4.** `CRON_SUBREQUEST_BUDGET` goes from 9000 to 900, below the 1000 D1 queries/invocation limit. The OAuth batch is still sized by its worst case. After it runs, it charges `oauthPurgeSubrequests(result, batch)`, which is proportional to records checked and purged plus list pages and is capped at the reserved worst case. On failure it charges the reserved worst case. `purgeExpiredAuthData` now returns `PurgeResult`.
- `docs/api-contract.md` is updated with the error code, the reveal row, the export coverage and the cron budget.

## Verification

- `bun run content:check` passes.
- `bun run test` passes: 41 files, 376 tests.
- `bun run build` passes: astro check reports 0 errors and 0 warnings, plus 1 hint that was already there.
- `tsc --noEmit` is clean.
- New tests cover: a non-JSON 403, a generic `forbidden` 403 and an `answer_locked` 403 without a run all keep edits; `answer_locked` restores only the locked fields; no step reset; the route emits `answer_locked`; the client maps the codes; `restoreDraft` prefers revealed server values; `run_hints` export and paging; the cascade FK; the budget is under 1000; the OAuth charge is proportional, capped, and the worst case on failure.
- No e2e selectors were changed.

## Unresolved questions

- The push job still sizes by `MAX_SENDS_PER_RUN = 1000`, but the 900 budget now caps it at about 176 sends per tick. If due reminders ever exceed that, catch-up relies on the 60-minute look-back.
