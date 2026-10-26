---
name: ai-unlocked
description: Learning companion for AI Unlocked (unlock.zuey.me). Use when the learner wants to learn or practise on unlock.zuey.me from Claude Code, connect the AI Unlocked MCP server, work on missions, hints or evidence, or install, check, pause or remove the optional ai-tutor Stop hook ("cài skill AI Unlocked", "kết nối unlock.zuey.me", "gỡ ai-tutor").
---

# AI Unlocked companion

AI Unlocked (https://unlock.zuey.me) teaches Vietnamese learners to use AI by doing real tasks (missions) and checking their own work. This skill helps you, the agent, (1) connect Claude Code to the AI Unlocked MCP server, (2) guide the learner through missions, and (3) optionally install **ai-tutor**, a Stop hook that sends redacted turns to a **server-side background analyzer** (it is not a Claude Code subagent).

The CLI is `node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" <command>`. Talk to the learner in Vietnamese.

## Hard rules

1. **Ask before every change.** Before `hook install`, `pair`, `hook uninstall`, `uninstall`, `upgrade`, `claude mcp add`, or any edit to a settings file, explain what will happen in one or two Vietnamese sentences and wait for an explicit "đồng ý". Offer `--dry-run` for hook changes.
2. **Never show or paste tokens.** Never print, read aloud, copy, or write the ingestion token anywhere (chat, files, settings, project dir). Never open `credentials.json`. The CLI only ever shows the last 4 characters.
3. **If the learner declines ai-tutor, stop after MCP setup.** MCP and learning keep working without the hook.
4. **Never edit `settings.json` by hand** for this skill; use the CLI, which only touches its own marked entry and keeps a backup.
5. **Other runtimes (Cursor, Codex, Gemini CLI, …) get MCP only.** Do not claim the hook works there.

## 1. Connect MCP

Ask first, then run:

```bash
claude mcp add --transport http ai-unlocked https://unlock.zuey.me/mcp --scope user
```

The learner then runs `/mcp` in Claude Code to sign in with their zuey.me account. Verify the 8 tools are listed: `get_profile`, `list_missions`, `get_mission`, `start_mission`, `get_run`, `submit_evidence`, `get_hint`, `abandon_mission`. Details and example prompts: [references/mcp-and-learning.md](references/mcp-and-learning.md).

## 2. Learn with missions

Use `get_profile` to see progress and active runs, `list_missions` / `get_mission` to pick one, `start_mission`, then help the learner do the work themselves. Give hints with `get_hint` (lowest level first) instead of answers, and submit with `submit_evidence` only when the learner says the work is theirs and ready.

## 3. Optional: ai-tutor

Explain this to the learner before asking for consent (Vietnamese, plain words):

- **What is sent** after each finished turn: the latest prompt you typed, Claude's final reply, and the names of the tools used (no arguments, no output), plus which AI Unlocked mission/run was touched.
- **Never sent**: hidden reasoning, file contents, the working directory, tool arguments or results, and secrets (API keys, tokens, passwords, emails, phone numbers, card numbers, home paths are masked on the machine and again on the server).
- **Where**: a background analyzer on the unlock.zuey.me server writes short reports the learner reads at `/insights`. It needs the "phân tích" consent in Settings on the web; without it the server stores nothing.
- **Control**: pause/resume any time, delete reports on the web, revoke the device, uninstall.

Full text: [references/privacy-and-consent.md](references/privacy-and-consent.md).

If the learner agrees, in this order, asking before each step:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" pair                       # shows a code; learner approves it at /insights/pair
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" hook install --scope user --dry-run
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" hook install --scope user  # or --scope project (this project only)
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" doctor
```

`pair` prints a code like `ABCD-EFGH` and a link; the learner opens it while signed in and approves. The token is saved straight to a private file; nothing to copy. Hook lifecycle, scopes and workspace trust: [references/hook-lifecycle.md](references/hook-lifecycle.md).

## 4. Check, pause, remove

```bash
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" status
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" doctor        # add --json for machine output
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" pause         # no transcript read, no network
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" resume
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" hook uninstall --scope all
node "${CLAUDE_SKILL_DIR}/scripts/ai-unlocked.mjs" uninstall --purge   # also revokes the device token
```

Doctor output meanings and manual removal: [references/troubleshooting.md](references/troubleshooting.md).
