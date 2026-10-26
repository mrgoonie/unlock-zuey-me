# Troubleshooting

Run `node "<skill dir>/scripts/ai-unlocked.mjs" doctor` (same CLI path as in SKILL.md; add `--json` for machine output). Each line is `[ok]`, `[warn]` or `[fail]` with `group/name`.

| Check | Meaning | Fix |
|---|---|---|
| `runtime/node` fail | Node < 18: the hook cannot run here | Use MCP only, or install Node 18+ |
| `runtime/platform` warn | Windows is untested | Prefer WSL |
| `skill/install` warn | Skill not found in `~/.claude/skills` or `.claude/skills` | Reinstall from https://unlock.zuey.me/skill |
| `skill/version` warn | A newer version is published | `upgrade` |
| `settings/<scope>` fail | File is invalid JSON, `disableAllHooks` is on, or the hook points at a missing file | Fix the JSON; rerun `hook install` |
| `settings/hook` warn | Hook not installed (optional) or present in several files | `hook install`, or `hook uninstall` in the extra scope |
| `settings/managed` fail | Organisation policy blocks personal hooks | Ask your admin; MCP still works |
| `connection/mcp` warn | No AI Unlocked MCP server configured | `claude mcp add --transport http ai-unlocked https://unlock.zuey.me/mcp --scope user` |
| `connection/credentials` warn/fail | Not paired, file mode too open, or token refused (401) | `pair` |
| `connection/consent` warn | "Phân tích" consent is off on the web | Turn it on in Settings, or leave ai-tutor off |
| `connection/server` warn | Feature off on the server, or no network | Nothing to do; the hook backs off by itself |
| `local/paused` warn | Capture paused | `resume` |
| `local/blocked` warn | Server back-off after consent off or feature off (24 h) | Turn consent on, then wait or re-pair |
| `local/parser` warn | The latest prompt could not be read from the transcript; only the final reply is sent | Usually a Claude Code format change; `upgrade` |

## Remove the hook by hand

If the CLI is gone, open `~/.claude/settings.json` (or `.claude/settings.local.json`) and delete the handler whose `command` contains `--ai-unlocked-hook=`. If its group has no other handler, delete the group too. Then delete `~/.config/ai-unlocked/` and revoke the device in Settings on the web.
