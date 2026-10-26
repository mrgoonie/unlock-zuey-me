# Phase 2 implementation report: ai-unlocked skill and Claude Code Stop hook

- Phase: plans/261026-2235-25-ai-tutor-insights/phase-02-skill-package-claude-code-adapter.md
- Branch: feat/25-insights-phase-2. It merges origin/main, which includes phases 0, 1, 3, 4 and 5.
- Status: completed. The manual check in a live Claude Code session has not been done yet.

## Delivered

### Skill package (`skills/ai-unlocked/`)

- `SKILL.md`, `manifest.json` (version 0.1.0) and four reference documents.
- `scripts/stop-hook.mjs` is the Stop hook:
  - It always exits 0 and writes nothing to stdout or stderr. It stops itself after 1.5 s.
  - It ignores `SubagentStop` and any payload that has an `agent_id`, and it respects `AI_UNLOCKED_INTERNAL=1`.
  - It reads no transcript and makes no network call when the device is unpaired or paused, during a back-off, or after a 401.
  - Spool files are written with mode 0600. Uploads run in a detached `flush-spool.mjs`.
- `scripts/ai-unlocked.mjs` is the CLI. Commands: `status`, `doctor [--json] [--offline]`, `pair`, `hook install|uninstall --scope`, `pause`, `resume`, `flush`, `upgrade` and `uninstall [--purge]`.
- `scripts/install.mjs` is the bootstrap installer. It runs when piped to `node -`, checks the manifest paths, verifies every file's sha256, writes to a staging directory and swaps it in, and restores the previous copy if anything fails.
- `scripts/lib/*` holds the shared code:
  - paths
  - marker-based settings merge (backup, atomic write, rollback; invalid JSON aborts without writing)
  - spool and lock
  - state and credentials
  - transcript window parser
  - payload builder (imports the Phase 0 `redact.mjs`, which is not modified)
  - ingest client (routes `/api/ingest/v1/*`)
  - flush runner (follows the contract's status table)
  - pairing (RFC 8628 polling: minimum 5 s, slow_down adds 5 s)
  - doctor

### Site

- `src/lib/skill/skill-bundle.ts` bundles the skill files with `import.meta.glob ?raw` and builds a manifest with sha256 and byte counts. Test files and dot-paths are excluded.
- `src/lib/skill/skill-routes.ts` serves the bundle.
- Routes: `/skill/manifest.json`, `/skill/install.mjs` and `/skill/files/[...path]`. All of them return 404 when `INSIGHTS_MODE=off`.
- `/skill` is a Vietnamese docs page. It covers what is collected, consent, install and uninstall.

### Pairing link

Pairing prints the user code and the link `${server}/insights/pair?code=<userCode>`, which is the Phase 4 approval page. The link is always built from the configured server. A host given in the server's response is never used.

## Cross-phase edit

`src/lib/insights/ingest-service.ts` (Phase 1): `LATEST_SKILL_VERSION` now comes from `skills/ai-unlocked/manifest.json` instead of the hardcoded `'0.1.0'`. The orchestrator asked for this change.

## Deviations from the phase file

The contract wins wherever the two disagree.

- **401:** the client sets `credentialsInvalid` and keeps the spool. The phase file says to clear the spool, but the contract table says keep.
- **403 `consent_required`:** uploads back off for 24 h, not 1 h. This follows the contract table.
- **`installSalt`:** it lives in `state.json`, not `credentials.json`, so re-pairing does not change `sessionRef`.
- **Hook command:** it uses the absolute `process.execPath` instead of `node`, so it still works under nvm and in desktop apps whose PATH lacks Node.
- **Doctor:** it reads the MCP config from `~/.claude.json` and `.mcp.json` rather than spawning `claude mcp get`, because doctor should spawn nothing.
- **MCP tools:** there are 8 platform tools, not 7; `abandon_mission` exists. They count only when the MCP server name matches `/unlock/i`.
- **Project-scope uninstall:** it also removes markers from the shared `.claude/settings.json`, in case someone copied one there by hand. Install never writes that file.

## Tests

New files are `tests/unit/skill-*.test.ts` (9 files), plus fixtures in `tests/fixtures/skill/`. Every test uses a temporary HOME and a local fake HTTP server, so nothing reaches production.

| File | Covers |
|---|---|
| skill-settings-merge | foreign hooks deep-equal; v0 upgrade; duplicates collapse; invalid JSON; dry-run; rename, corrupt-write and EACCES rollback; mode and indent; scopes |
| skill-transcript-window | prompt and tools window; injected or sidechain lines skipped; torn tail; garbage; caps; 512 KB tail |
| skill-ingest-contract | payload satisfies the strict `ingestTurnV1Schema`; constants and pairing patterns mirror the contract; redaction; 16 KB cap; idempotency key |
| skill-stop-hook | exit 0 and silent in every case; transcript never opened without credentials (fs spy); `stop_hook_active` keeps the key; INTERNAL flag; no secret in spool or request |
| skill-spool-flush | every row of the status table; stale-lock recovery; live lock; caps of 50 files, 1 MB and 24 h; log never contains the token |
| skill-cli-lifecycle | user and project install/uninstall; dry-run; invalid JSON; pause/resume; status never prints the token; `uninstall --purge` sends DELETE /token; doctor; pairing 428, 429, 200 and 410; pairing link |
| skill-stop-hook-overhead | 40 runs, 300 KB transcript, server delayed 5 s: p95 < 250 ms; spool drains afterwards |
| skill-install-bootstrap | success; piped `node -`; sha256 mismatch keeps the old directory; traversal paths rejected; https required |
| skill-bundle-manifest | bundle matches disk byte for byte; hashes; version; routes 404 when off and serve when on |

## Results

| Check | Result |
|---|---|
| `bun run content:check` | ok |
| `bun run migrations:check` | ok |
| `bun run test` | 79 files, 856 tests, all pass |
| `bun run build` (astro check: 0 errors) | ok |

A bare `tsc --noEmit` reports only `import.meta.glob` and `astro:middleware` typing errors. Those come from missing Astro ambient types, and the existing `loader.ts` and `middleware.ts` show the same errors. `astro check` passes cleanly.

## Unresolved questions

- The manual check in a real Claude Code session (install, pair against `wrangler dev`, run a turn, uninstall, diff `settings.json`) has not been done. It needs a person and a local D1/KV.
- The transcript fixture was generated to match the format observed in Claude Code 2.1.304, not recorded from a live session.
- The `/skill` page builds its install command from `Astro.url.origin`. Should it use `PUBLIC_SITE_URL` behind a proxy?
