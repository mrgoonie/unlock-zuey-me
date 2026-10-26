# Learning integrity fixes (M1, M2, M3, L2 finalize half, L3, L4, L7)

Part of #1. Branch `fix/learning-integrity`, rebased on main after #14.

## Changes
- **M1, evidence after a merge.** `evidence-store.ts` resolves an image's uploader through `learners.merged_into`.
  - A member can read and resubmit images they uploaded as a guest. This covers the retry ("Chấm lại") path and a pre-merge draft.
  - Admin access follows the consent of the effective learner, which is the member.
  - `getObservedLearner` filters `merged_into IS NULL`, so merged guests no longer appear to admins.
  - Images are not moved or copied, and their keys keep the guest prefix. This stays consistent with the orphan-evidence cron from #14, which uses the unchanged `evidenceKeyOwner` export and already checks the submissions and runs of `merged_into`.
- **M2, answer keys stay on the server.** `learner-mission-view.ts` builds an explicit allow-list view of a mission. It has no keys, explanations, hints, rubric checks or guidance.
  - `run.astro` and `GET /api/v1/runs/:id` serve only that view.
  - `answerKey` holds every key once the run is completed (on GET and in the submit response). Before that, it holds only the items the learner has revealed.
  - The new `POST /api/v1/runs/:id/reveal` records the reveal in `mission_runs.revealed_json` and returns that item's key.
  - After a reveal, saving or submitting a changed answer for that item returns `forbidden`.
- **M3, XP once per mission.** The `mission_pass` ledger ref is now the mission id, so a later passing run earns 0 XP and shows a note.
  - `start` with no body opens the open run if there is one. Otherwise it opens the latest completed result read-only, with a "Làm lại" button. Otherwise it starts a new run.
  - `{again:true}` always starts a new run.
- **L2, finalize half.** The evaluation insert only happens while the run is still `evaluating` at the claimed rev. The run update, the XP row and the competency upserts all require that evaluation row.
  - A stale evaluation that finishes after a retry re-claimed the run writes nothing and gets `conflict`.
- **L3.** The submission insert and the run claim run in one D1 batch. Each statement is guarded on the run's rev and status.
- **L4, one open run per mission.** Migration `0004_learning_integrity.sql` does three things:
  - abandons older duplicate open runs, then adds a partial unique index;
  - adds `revealed_json`;
  - re-keys existing `mission_pass` ledger rows.

  When two starts race, the loser gets the winner's run. A guest merge abandons the older open run.
- **L7.** The MCP `get_hint` description now gives `forbidden` as the error for a locked level.

## Tests
- New test files:
  - `learning-answer-keys-and-reveals.test.ts`
  - `learning-merge-evidence-and-repeat-runs.test.ts`, which includes the stale-finalize race
  - `migration-learning-integrity.test.ts`
- `bun run content:check` OK. `bun run test`: 39 files, 338 tests pass. `bun run build`: 0 errors.
- The test helper `d1-sqlite.ts` now runs `batch` synchronously, so it is atomic like D1. Before, two concurrent batches could interleave.

## Notes
- **e2e was not run locally.** `bun run dev` fails with "Failed to create a preview token" because the remote bindings need Cloudflare auth, and `wrangler.jsonc` is out of scope.
  - No selectors used by the guest-plan-weekend or labs specs changed. A fresh mission still opens a new run, and a first pass still shows `xp-gained` and the badge.
  - No dev server was left running.
- **Files touched outside the listed ownership** (needed for the contracts above):
  - `src/lib/db/{run-repository,evaluation-repository,progress-queries}.ts`
  - `src/lib/ui/{api-client,mission-steps,run-draft}.ts`
  - `docs/api-contract.md`
  - `tests/helpers/d1-sqlite.ts`
- **Hints.** The browser no longer has static hints, because hints are no longer shipped to it. The hint ladder now uses only the server hint endpoint.
