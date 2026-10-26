# Hook lifecycle

The hook is one `Stop` handler. It is never registered on `SubagentStop`, and it ignores any payload carrying `agent_id`.

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "\"/path/to/node\" \"/Users/me/.claude/skills/ai-unlocked/scripts/stop-hook.mjs\" --ai-unlocked-hook=v1", "timeout": 10 } ] } ] } }
```

The `--ai-unlocked-hook=v1` marker is how install and uninstall recognise their own entry. Everything else in the file is left as it was.

## Scopes

| `--scope` | File | Who gets the hook |
|---|---|---|
| `user` | `~/.claude/settings.json` | You, in every project |
| `project` | `<project>/.claude/settings.local.json` | You, in this project only (the file stays out of git) |

The committed `.claude/settings.json` is never written, so teammates never receive the hook from the repository. `hook uninstall --scope project` also removes a marker someone copied into it by hand; `--scope all` covers user and the current project.

## Install, upgrade, uninstall

- `hook install` is idempotent: run it twice and there is still exactly one entry. An older marker (`v0`) is replaced in place, duplicates collapse to one.
- Before writing, the CLI keeps `settings.json.ai-unlocked.bak`, writes a temp file, renames it, re-reads it, and restores the backup on any failure. A file with invalid JSON (comments, trailing commas) is never rewritten: fix it first.
- `--dry-run` prints the diff and writes nothing.
- `upgrade` re-downloads the skill (sha256-verified) and refreshes the hook command.
- `uninstall` removes the hook from every scope, the spool and local state; `--purge` also revokes the device token and deletes the credentials.

Claude Code reloads hook changes in settings files while running; if a change does not show up after a few seconds, restart the session.

## When the hook does not run

- **Workspace trust.** In an interactive session Claude Code holds back hooks from every settings file until you accept the trust dialog for the folder. `-p` runs treat the folder as trusted.
- **`disableAllHooks: true`** in any settings level turns hooks off; managed `allowManagedHooksOnly` blocks personal hooks. `doctor` reports both.

## What the hook does on each turn

1. Exits at once inside processes started by this package (`AI_UNLOCKED_INTERNAL=1`), on `SubagentStop`, or when `agent_id` is present.
2. Exits without reading the transcript when paused, unpaired, refused by the server, or in a back-off window.
3. Otherwise reads the tail of the transcript, redacts, writes one 0600 spool file, starts a detached uploader, and exits 0 with no output. It never blocks the stop and never asks Claude to continue.
