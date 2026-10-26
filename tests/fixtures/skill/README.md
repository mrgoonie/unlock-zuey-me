# ai-unlocked skill fixtures

- `settings/`: Claude Code settings files with foreign hooks (user, shared project), old `v0` and duplicate
  markers (local), and an invalid file with a comment.
- `stop-payloads/`: Stop hook stdin shaped after https://code.claude.com/docs/en/hooks ("Stop input",
  "SubagentStop"), verified 2026-10-26. `TRANSCRIPT_PATH` is replaced by the tests.
- `transcripts/`: transcript JSONL. `claude-code-2.1.304-mission-turn.jsonl` reproduces the line shapes recorded
  from Claude Code 2.1.304 (envelope keys, `isMeta`, `isSidechain`, `tool_use` / `tool_result` with `is_error`,
  injected `<task-notification>` lines), scrubbed and rewritten with synthetic content. The transcript format is not
  a documented contract; these fixtures pin what the parser relies on.
