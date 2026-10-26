# Phase 6 report: integration tests, e2e, docs and rollout (#25)

- Phase: `plans/261026-2235-25-ai-tutor-insights/phase-06-integration-e2e-docs-rollout.md`
- Branch: `feat/25-insights-phase-6` (from `origin/main` at 0a0cdc4, which includes phases 0–5)
- Status: completed. No phase code was changed.

## Files

| File | Change |
|---|---|
| `tests/unit/insights-end-to-end-pipeline.test.ts` | new, 3 tests |
| `tests/unit/insights-feature-off-regression.test.ts` | new, 6 tests |
| `e2e/insights.spec.ts` | new, 18 flag-off checks + 3 flag-on checks |
| `docs/api-contract.md` | new "ai-tutor insights" section: learner, ingest, admin (incl. proposals and settings), error reasons, test hooks; `/api/ingest/**` added to the no-session list |
| `docs/insights-ingest-contract.md` | real processing order, identifier handling on redaction, stored payload shape, pairing details, new "After ingest" section (analyzer, reports, proposal and issue gate) |
| `docs/insights-rollout.md` | new: rollout checklist, GitHub evaluation gate, rollback, manual QA script |
| `README.md` | structure rows `src/lib/insights/`, `skills/ai-unlocked/`; `/skill` link; optional `GITHUB_ISSUES_TOKEN`; `INSIGHTS_*` vars; doc links; `bun run e2e` |
| `plans/.../phase-06-...md` | implementation notes (status cells untouched) |

The rollout checklist went into a new `docs/insights-rollout.md` rather than `docs/deployment.md`, so deployment stays about deploys and migrations and the operator runbook has one home.

## What the tests prove

**End-to-end pipeline** (all in-process, real schema, real route handlers, mocked OpenRouter fetch and draft model, GitHub off):
- Three learners go through consent (PATCH route) → device pairing (start/confirm/poll routes) → payload from the skill's `turn-payload.mjs` → `POST /api/ingest/v1/turns` → `runInsightsPipeline` ticks (retention → analyzer → proposal) → learner reports API → admin proposals list/detail/settings → operator summary.
- alpha and bravo have `proposals=1`, charlie has analysis only. Result: 3 reports, 2 linked and 1 ignored, one dashboard proposal (content needs 2 learners), no signal on the summary (needs 3 with proposals consent), skills aggregate over all 3.
- Redaction is asserted at each hop: device payload, queue rows (bravo simulates an outdated client sending raw secrets; the server masks them), model request bodies, learner API, draft prompts, issue markdown, operator summary, and finally a dump of every table. charlie's text never reaches signals, drafts or the issue body. GitHub mock and global `fetch` are never called.
- Revoke mid-chain: a revoke before the tick purges the queued turn; a revoke during the model call leaves no report and no events; later turns get `403 consent_required` and nothing is stored.
- Duplicate Stop: the same turn twice plus a `stop_hook_active` re-fire is one event (payload replaced while pending) and one report; a late duplicate changes nothing.

**Feature-off regression:** every handler under `src/pages/api/ingest`, `api/v1/insights`, `api/v1/admin/insights` and `src/pages/skill` (found with `import.meta.glob`, floor of 19 files / 21 handlers) answers 404 for an admin, a member and no learner, with mode unset, `off`, `''` or a bogus value, while D1 and KV are proxies that throw on any use. The cron job returns `flag_off` with the real stages and charges nothing. `MCP_SCOPES` is still `['learn:read','learn:write']`. The observer list and detail key sets are snapshotted, and seeded insight rows never appear in them. `learnerPolicy` changes only for `/api/ingest/**`; every other insights path has the same policy as a pre-existing equivalent.

**E2E** (`e2e/insights.spec.ts`): with the flag off, 12 insights pages, APIs and `/skill` files are 404 for a browser guest, ingest answers `404 feature_off`, `/progress` has no `/insights` link, and Settings has no `s-insights` section. Per the orchestrator's note, a session-less client gets the same status on the insights APIs as on a nonexistent `/api/v1` path (401 from the middleware). With `E2E_INSIGHTS=1`, a guest gets the sign-in CTA on `/insights/pair` with `return_to` keeping the code, `/insights` stays 404, and every `/skill` file matches its manifest sha256 and byte count, as does `/skill/install.mjs`.

## Gates

| Check | Result |
|---|---|
| `bun run content:check` | OK |
| `bun run migrations:check` | OK |
| `bun run test` | 81 files, 865 tests, all pass |
| `bun run build` (astro check) | 0 errors, 0 warnings |
| `E2E_BASE_URL=https://unlock.zuey.me bunx playwright test e2e/insights.spec.ts` | 18 passed, 3 skipped (flag-on block) |
| `E2E_BASE_URL=http://localhost:8787 E2E_INSIGHTS=1 …` (local preview, `INSIGHTS_MODE=on`) | 4 passed, 14 skipped |

## Manual QA: what was and was not run

Run locally, with no production access. The preview was `wrangler dev --port 8787 --var INSIGHTS_MODE:on --var SESSION_SECRET:<throwaway>` on a local D1 with migrations applied. It was stopped afterwards.

- Done: the installer round-trip in a throwaway HOME (scratch dir). `curl …/skill/install.mjs | node - --scope user --server http://localhost:8787` installed 27 files with sha256 checked, and exited 0. Running `hook install` twice left exactly 1 marker entry, and the foreign Stop hook was kept. `status` and `doctor --offline` were OK. The Stop hook without credentials exited 0 with an empty stdout. `uninstall --purge` removed the hook, the credentials and the skill dir, and `settings.json` was **byte-identical** to the original when that file was 2-space JSON.
- Done: ingest probes on the preview: a bogus token got 401 `unauthorized`, an `Origin` header got 403 `origin_forbidden`, and `pair/start` returned a code with `verificationUri` built from `PUBLIC_SITE_URL`.
- Not run (needs a zuey.me member/admin session and a real Claude Code session): pairing approval, real turns through the MCP tools, the cron via `__scheduled`, the report on `/insights`, revoking in Settings with `doctor` showing the refusal, revoking the token from `uninstall --purge` server-side, and timing 20 hook runs. The script for these is in `docs/insights-rollout.md`.
- Nothing touched production data or vars, and no `wrangler deploy` was run. The only production traffic was the read-only e2e and curl GETs, plus one POST to ingest that was rejected with 404.

## Observations (no code changed)

1. **Revoke counter:** when a learner revokes analysis during the model call through the real consent route, the purge deletes the leased events. `completeWindow` then reports `lease_lost` rather than `revoked`, so `AnalyzerStageResult.revoked` stays 0. Privacy is intact (no report, no events). Only that log counter under-reports. The phase 3 test revokes with a bare UPDATE that does not purge, which is why it sees `revoked: 1`. Possible fix: count `lease_lost` as revoked when consent is gone.
2. **Settings formatting:** `uninstall` normalises `settings.json` to 2-space JSON. If the original used other formatting, it comes back deep-equal but not byte-identical. The QA script now says so.
3. **Doctor MCP hint:** `doctor` suggests `claude mcp add … https://unlock.zuey.me/mcp` even when `AI_UNLOCKED_SERVER` points at localhost. The installer prints the right server. This is cosmetic.

## Unresolved questions

- Should observation 1 (the revoke counter) be fixed in a follow-up, or is the logged counter not relied on?
- The member-only manual QA steps need a person with an admin account before `INSIGHTS_MODE=internal` goes live.
