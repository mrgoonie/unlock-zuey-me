# Phase 2: Skill package, Claude Code adapter, site distribution

Effort 11h · Depends on: 0 (contract and `redact.mjs`) · Parallel with: 1, 3, 4, 5 (codes against `docs/insights-ingest-contract.md`; a mock server in tests) · Status: pending

## Context: verified Claude Code facts (fetched 2026-10-26)

| Fact | Source |
|---|---|
| Stop input: `session_id`, `prompt_id`, `transcript_path` (`.jsonl`), `cwd`, `permission_mode`, `hook_event_name`, `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. `agent_id`/`agent_type` appear only inside a subagent. Use `last_assistant_message` because the transcript "isn't guaranteed to include the final message at Stop time". | https://code.claude.com/docs/en/hooks (Stop input) |
| SubagentStop is a separate event for subagents. A subagent's frontmatter `Stop` hook is converted to SubagentStop. | https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/sub-agents |
| Exit 0 with no stdout = no effect (the stop is allowed). Exit 2 on Stop blocks, and Claude continues. `decision:"block"` continues the turn. Other exit codes are non-blocking errors unless `onFailure:"block"`. | https://code.claude.com/docs/en/hooks (Stop decision control) |
| `async: true` exists for `type:"command"` only: Claude does not wait, and the timeout is not enforced once the hook is backgrounded. **With `claude -p`, async hooks still running at teardown are killed (`cancelled`).** | https://code.claude.com/docs/en/hooks (async hooks) |
| `http` hooks exist (url, headers with `allowedEnvVars`) but do not support `async`, so they block until the response or the timeout. | https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/hooks-guide |
| Command hook default timeout is 600 s. The `timeout` field is in seconds. | https://code.claude.com/docs/en/hooks (Limitations) |
| Settings files: `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed. Hooks from all levels **combine**. An identical handler in two files runs once. `disableAllHooks` and managed `allowManagedHooksOnly` exist. Hook edits are applied live by the file watcher. Hooks are held back until the folder is trusted. | https://code.claude.com/docs/en/settings, https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/hooks-guide |
| Skills live at `~/.claude/skills/<name>/SKILL.md` (personal) and `.claude/skills/<name>/SKILL.md` (project). `${CLAUDE_SKILL_DIR}` is substituted in skill text. Frontmatter `hooks` only last for the session after invocation, so they are unsuitable for a persistent hook. | https://code.claude.com/docs/en/skills |
| Plugins (`.claude-plugin/plugin.json`, `hooks/hooks.json`) install through `/plugin marketplace add owner/repo`, and their hooks are active once enabled. | https://code.claude.com/docs/en/plugins, https://code.claude.com/docs/en/plugin-marketplaces |
| No documented way exists for a hook to launch a subagent. | https://code.claude.com/docs/en/sub-agents |

**Unverified** (handle defensively and pin with fixtures): the transcript JSONL line schema; the managed-settings file paths per OS; whether a `claude -p` child started from a hook re-runs hooks (we never start one).

## Design decisions specific to this phase

1. **Sync command hook, spool first, detached flush.** The hook does bounded local work (stdin → redact → 0600 spool file), spawns `flush-spool.mjs` detached with `stdio:'ignore'` and `unref()`, and exits 0 with empty stdout. We do not use `async: true`, because `-p` teardown kills async hooks and the turn would be lost. The spool file is on disk before the hook exits, which is the durability point required for one-shot sessions. The settings entry sets `timeout: 10` as a safety net.
2. **Registered only on `Stop`**, never SubagentStop. The hook also ignores any payload with `agent_id` or `hook_event_name !== 'Stop'`, and exits immediately when `AI_UNLOCKED_INTERNAL=1`. Nothing in this package starts `claude`, so a Stop → ai-tutor → Stop loop cannot form.
3. **Scopes.**
   - `--scope user` writes `~/.claude/settings.json`.
   - `--scope project` writes `<project>/.claude/settings.local.json`. This file is personal, so the hook is never installed for teammates through the committed `.claude/settings.json`.

   Both are tested, and the tests also prove that foreign entries in `.claude/settings.json` are left untouched.
4. **Marker.** The command string contains `--ai-unlocked-hook=v<major>`, with an absolute script path resolved at install time:

   ```json
   { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node \"/Users/me/.claude/skills/ai-unlocked/scripts/stop-hook.mjs\" --ai-unlocked-hook=v1", "timeout": 10 } ] } ] } }
   ```

   Install finds every handler whose `command` contains `--ai-unlocked-hook=` across every `Stop` group. With none, it appends one new group. With one, it replaces that handler in place (upgrade). With more than one, it keeps the first, replaces it, and removes the rest. Uninstall removes only marker handlers, then removes a group left with an empty `hooks` array, then an empty `Stop`, then an empty `hooks` object. Every other key is preserved.
5. **Safe writes.** Install reads the file, then `JSON.parse`. If the file is invalid, it aborts with a message and writes nothing. It copies the original to `settings.json.ai-unlocked.bak`, writes `*.tmp`, `fsync`s, renames, re-reads and re-parses the result, and restores the backup on any failure. The file mode is preserved. `--dry-run` prints a unified diff instead of writing.
6. **Credentials** live in `${XDG_CONFIG_HOME:-~/.config}/ai-unlocked/credentials.json` (`%APPDATA%\ai-unlocked` on Windows), with the file at 0600 and the dir at 0700. The file holds `{server, token, tokenId, installSalt, pairedAt}`. `AI_UNLOCKED_INGEST_TOKEN` overrides it. The token is never printed, logged, put in the project dir, or put in `settings.json`, and `doctor` shows only the last 4 chars.
7. **Runtime.** Node ≥ 18 (global `fetch`). Without Node, doctor reports "không hỗ trợ hook trên máy này" and the skill falls back to MCP only. macOS and Linux are supported. Native Windows gets a doctor warning (`chưa kiểm thử`), and WSL works.

## Files to create (all under `skills/ai-unlocked/` unless noted)

| File | Purpose |
|---|---|
| `SKILL.md` | Frontmatter `name: ai-unlocked`, `description` (when to use: learning on unlock.zuey.me, MCP setup, installing or removing the ai-tutor hook). The body, in Vietnamese-friendly English, covers: (a) connecting `/mcp`, where the agent runs `claude mcp add --transport http ai-unlocked https://unlock.zuey.me/mcp --scope user` after asking, then verifies the 7 tools; (b) learning flow (missions, hints, evidence) and using the MCP tools; (c) the optional ai-tutor, stating what is collected (latest user prompt, final assistant reply, tool names) and what is never collected (hidden reasoning, file contents, `cwd`, secrets after redaction), plus where it is processed (server-side analyzer, not a subagent); (d) **hard rules: ask the user before `hook install`, `pair`, `uninstall`, and any settings change; never print or paste tokens; if the user declines, stop after MCP setup**; (e) `doctor`, pause/resume, uninstall; (f) other runtimes are MCP only and nothing claims otherwise. Uses `${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs`. |
| `manifest.json` | `{ "name":"ai-unlocked", "version":"0.1.0", "minNode":18, "hookMarker":"v1" }` |
| `references/mcp-and-learning.md` | MCP tools, mission flow, example prompts |
| `references/privacy-and-consent.md` | The three consents, what is sent, redaction, retention, export/delete, revoke behaviour |
| `references/hook-lifecycle.md` | Install, upgrade, uninstall, pause, scopes, trust dialog, `disableAllHooks` |
| `references/troubleshooting.md` | Doctor output meanings |
| `scripts/ai-unlocked.mjs` | CLI: `status`, `doctor [--json]`, `pair [--label]`, `hook install --scope user\|project [--dry-run]`, `hook uninstall --scope user\|project\|all`, `pause`, `resume`, `flush`, `upgrade`, `uninstall [--purge]`. Exit codes: 0 ok, 1 user error, 2 environment unsupported. Never prints the token. |
| `scripts/stop-hook.mjs` | Hook entry (algorithm below) |
| `scripts/flush-spool.mjs` | Detached uploader (algorithm below) |
| `scripts/install.mjs` | Bootstrap served at `/skill/install.mjs`: fetches `/skill/manifest.json`, downloads `/skill/files/<path>`, verifies sha256, rejects paths that fail `^[a-z0-9][a-z0-9._/-]*$` or contain `..`, stages to `<target>.staging`, renames the current dir to `<target>.prev` and staging to target, and restores `.prev` on failure. `--scope user` targets `~/.claude/skills/ai-unlocked`; `--scope project` targets `./.claude/skills/ai-unlocked`. It never touches settings and prints the next steps. |
| `scripts/lib/paths.mjs` | Resolves config, spool, skill, and settings paths from injected `{home, cwd, env, platform}` (testable) |
| `scripts/lib/settings-merge.mjs` | `planInstall(json, command)`, `planUninstall(json)`, `findMarkerHandlers(json)`, `applyToFile(path, planFn, {dryRun})` (pure planners plus one IO function) |
| `scripts/lib/transcript-window.mjs` | Reads the last ≤ 512 KB of `transcript_path` (it must be a regular file). Walks lines backwards and parses them. The latest `type:"user"` entry whose `message.content` is a string, or has text parts but no `tool_result`, is the prompt. It collects assistant `tool_use` names after it, with counts. For `mcp__<server>__<tool>` names where `tool ∈ {get_profile, list_missions, get_mission, start_mission, get_run, submit_evidence, get_hint}` it captures only `mission_id`/`run_id` inputs that match the server's regexes (`src/lib/mcp/tools/tool-schemas.ts:4,7`). Any parse error yields `{userPrompt:null, tools:[]}`. |
| `scripts/lib/turn-payload.mjs` | Builds the contract-v1 body: `idempotencyKey = sha256(session_id + ':' + (prompt_id ?? sha256(last_assistant_message)))`, `sessionRef = sha256(session_id + installSalt)`, `redactText` on every string, field truncation (4000/6000 chars), 16 KB overall target (trims the assistant text first) |
| `scripts/lib/spool.mjs` | Atomic 0600 writes to `spool/`, caps (50 files, 1 MB, drop oldest, drop > 24 h), O_EXCL flush lock that goes stale after 60 s |
| `scripts/lib/local-state.mjs` | `state.json`: `{paused, serverBlockedUntil, blockReason, credentialsInvalid, lastResult:{status, at}}` |
| `scripts/lib/credentials.mjs` | Read/write with mode enforcement; doctor warns if the mode is looser than 0600 |
| `scripts/lib/ingest-client.mjs` | `postTurn`, `getStatus`, `revokeSelf`, `pairStart`, `pairPoll` (fetch with AbortController timeouts) |
| `scripts/lib/doctor.mjs` | Checks with `ok/warn/fail`. **Runtime:** Node version, platform. **Skill:** install location(s), version vs `/skill/manifest.json`. **Settings files:** user, project-shared, and project-local parse; marker count per file; duplicate across files → warn; `disableAllHooks:true` → fail; managed settings present with `allowManagedHooksOnly` → fail (paths `[UNVERIFIED]`, best effort). **Connection:** MCP configured (best effort via `claude mcp get ai-unlocked` when `claude` is on PATH); credentials present with mode; server status (feature, `analysis` consent, token expiry). **Local state:** spool size, last upload, paused; a workspace-trust reminder. |
| `src/lib/skill/skill-bundle.ts` | `import.meta.glob('/skills/ai-unlocked/**/*', { query:'?raw', import:'default', eager:true })` → path→text map, minus `*.test.*`. `skillManifest()` adds `files:[{path, sha256, bytes}]` (SHA-256 via `crypto.subtle`, memoised per isolate). |
| `src/pages/skill/index.astro` | Vietnamese docs page "AI Unlocked cho Claude Code". It covers: what the skill does; a copy-paste prompt for Claude Code ("Cài skill AI Unlocked từ https://unlock.zuey.me/skill …"); the manual command; what is and is not collected; that the hook is optional and asked for; uninstall; and other runtimes (MCP only). Hidden (404) when `INSIGHTS_MODE=off`. |
| `src/pages/skill/manifest.json.ts`, `src/pages/skill/files/[...path].ts`, `src/pages/skill/install.mjs.ts` | `text/plain; charset=utf-8` (the manifest is JSON), `cache-control: public, max-age=300`, 404 for unknown paths or when the flag is off |
| Tests | `tests/unit/skill-settings-merge.test.ts`, `skill-cli-lifecycle.test.ts`, `skill-stop-hook.test.ts`, `skill-spool-flush.test.ts`, `skill-transcript-window.test.ts`, `skill-stop-hook-overhead.test.ts`, `skill-bundle-manifest.test.ts`, `skill-ingest-contract.test.ts` (validates `turn-payload.mjs` output with `ingestTurnV1Schema` from phase 0, so client/server drift fails CI); fixtures under `tests/fixtures/skill/` (sample settings files with foreign hooks, transcript JSONL samples recorded from a current Claude Code build, Stop payloads incl. a SubagentStop payload with `agent_id`) |

## Hook algorithm (`stop-hook.mjs`); every branch ends `process.exit(0)` with empty stdout

1. If `AI_UNLOCKED_INTERNAL === '1'`, exit.
2. Read stdin (cap 1 MB, 2 s guard) and parse it. On failure, exit.
3. If `hook_event_name !== 'Stop'` or `agent_id` is present, exit (no subagent capture).
4. Load the state. Exit if any of these holds:
   - `paused`;
   - `serverBlockedUntil > now`;
   - `credentialsInvalid`;
   - no credentials (the transcript is never opened without credentials).
5. Build the payload: `transcript-window` + `last_assistant_message` + redaction + caps. `cwd`, `permission_mode`, and file contents are never included.
6. Spool it atomically.
7. If no live flush lock exists, spawn `process.execPath flush-spool.mjs` detached with `stdio:'ignore'` and `env:{...process.env, AI_UNLOCKED_INTERNAL:'1'}`, then call `unref()`.
8. Exit. The whole body sits in `try/catch` with a 1.5 s self-deadline timer (`setTimeout(() => process.exit(0), 1500).unref()`).

## Flush algorithm (`flush-spool.mjs`)

Acquire the lock, or exit if it is held. Process files oldest first and POST each with an 8 s timeout:

| Response | Action |
|---|---|
| `202` | Delete the file |
| `400` | Delete the file (log the code only) |
| `401` | Set `credentialsInvalid`, clear the spool, stop |
| `403 consent_required` | `serverBlockedUntil = now + 1 h`, clear the spool, stop |
| `404` (feature off) | `serverBlockedUntil = now + 24 h`, clear the spool, stop |
| `429` / `5xx` / network error | Stop and keep the files for the next run |

Files older than 24 h are dropped. The log `~/.config/ai-unlocked/hook.log` records only the timestamp, HTTP status, and duration, and is capped at 64 KB.

## Steps

1. `paths`, `settings-merge` (pure), and the merge tests with fixtures (user / project-shared / project-local, foreign hooks, invalid JSON, permission-denied write → rollback).
2. `transcript-window` and `turn-payload`, the contract test against `ingestTurnV1Schema`, and transcript fixtures. Record a real transcript sample with a local Claude Code run, scrub it, and note the CLI version in the fixture header.
3. `spool`, `local-state`, `credentials`, `ingest-client`, and `stop-hook` / `flush-spool` with tests against a `node:http` mock server.
4. The CLI commands, `pairing` (start → print `userCode` + URL → poll until approved/expired; the token is written straight to credentials and never printed), and `doctor`.
5. `install.mjs` bootstrap and its test against a mock HTTP server: sha256 mismatch → abort with the old dir intact; traversal path → abort.
6. Site routes plus `skill-bundle.ts` and the manifest test (every served file hashes to the manifest value; no `tests/` content is served).
7. SKILL.md and references, then a manual check in a real Claude Code session: install, pair against local `wrangler dev`, run a turn, see the event row, uninstall, and confirm `settings.json` is identical to before.

## Tests (must cover)

- **Install / upgrade / uninstall** in all three files:
  - Foreign `Stop` and `PreToolUse` handlers stay byte-identical (deep-equal) after install → install → uninstall.
  - A v0 marker gets upgraded to v1 in place.
  - Duplicate markers collapse to one.
  - Invalid JSON is left untouched.
  - A rename failure restores the backup.
  - `--dry-run` causes no write.
  - `hook uninstall --scope all` removes from both user and project-local.
- **Stop hook:**
  - Exit code 0 and empty stdout in every case: garbage stdin, SubagentStop, `agent_id`, paused, no credentials, server 500, server timeout.
  - No credentials → the transcript file is never opened (spy on `fs`).
  - `stop_hook_active:true` → same idempotency key as the first fire.
  - `AI_UNLOCKED_INTERNAL=1` → no spool.
- **Spool / flush:**
  - A killed flush (lock left) is recovered after 60 s.
  - 401 → `credentialsInvalid` and the spool is cleared.
  - 403 `consent_required` → blocked for 1 h with no further POSTs.
  - 5xx → kept.
  - Caps enforced.
- **Overhead** (`skill-stop-hook-overhead.test.ts`): 40 spawned runs with a 300 KB transcript fixture and a mock server that sleeps 5 s. p95 wall time is under 250 ms (overridable by `SKILL_HOOK_P95_MS` for slow CI), every exit code is 0, and the spooled files are eventually uploaded by the detached flush. The test waits on the lock release.
- **Redaction:** a secret in the transcript never appears in the spool file or the request body.

## Success criteria

- All `skill-*` tests are green in CI (Node 24).
- In a manual session, the hook adds no visible delay, and uninstall restores the original `settings.json` (diff empty).
- `/skill` serves files whose hashes match the manifest.

## Risks

| Risk | L × I | Mitigation |
|---|---|---|
| Transcript format changes | M × M | `last_assistant_message` floor, defensive parser, fixture tests, doctor "parser: degraded" |
| Detached child killed by the parent's process group | L × M | `detached:true` (new process group on POSIX). The spool survives regardless, and the next Stop or `flush` resends. |
| User's settings have comments or odd formatting | L × M | Strict JSON required (abort otherwise). Pretty-printing with 2 spaces is documented. A backup is kept. |
| Agent pastes the pairing URL into the chat | L × L | The user code is not a secret on its own: it needs the signed-in learner's approval and expires in 10 min. The token never appears in output. |
| `astro check` type-checks every JS file in the project (`playwright.config.ts:14-16` comment; `tsconfig.json` includes `**/*`), so the skill's `.mjs` scripts fail the build | M × M | Keep the scripts check-clean with JSDoc types and Node built-in types (`@types/bun` already provides `node:*`). Fallback: add `"skills/ai-unlocked/scripts"` to `tsconfig.json` `exclude` (a one-line phase 0 follow-up) while `redact.d.mts` keeps the server import typed. |
| p95 test flakes on CI | M × L | Threshold override env var, and the median is reported. Retried once at most, via vitest `retry: 1` on this file only. |

## Rollback

On a machine, run `ai-unlocked uninstall [--purge]`, or delete the marker handler by hand (documented in troubleshooting). On the site, set `INSIGHTS_MODE=off` and the `/skill` routes 404. Installed hooks then get 404, clear their spool, and back off for 24 h.
