# MCP tools and the learning flow

Server: `https://unlock.zuey.me/mcp` (Streamable HTTP, OAuth with the learner's zuey.me account, members only).

```bash
claude mcp add --transport http ai-unlocked https://unlock.zuey.me/mcp --scope user
```

Then `/mcp` in Claude Code → `ai-unlocked` → sign in. Write tools need the `learn:write` scope granted on the consent screen.

## Tools

| Tool | Input | Use |
|---|---|---|
| `get_profile` | none | Level, XP, streak, active runs |
| `list_missions` | none | Mission catalog with status |
| `get_mission` | `mission_id` | Brief, steps and rubric of one mission |
| `start_mission` | `mission_id` | Start or resume a run, returns `run_id` |
| `get_run` | `run_id` | Current answers, step states, feedback |
| `submit_evidence` | `run_id`, `answers`, `confidence?` | Submit the learner's own work for grading |
| `get_hint` | `run_id`, `step_id`, `level` 1–4 | Graduated hint; start at level 1 |
| `abandon_mission` | `run_id` | Stop a run |

## How to coach

- The learner does the work. Explain, ask questions, and use `get_hint` from level 1 up instead of writing the answer.
- Before `submit_evidence`, read back what will be submitted and ask "Gửi bài này nhé?".
- After grading, go through the feedback together and suggest one concrete next step.

## Example prompts (learner → Claude Code)

- "Cho mình xem tiến độ học trên AI Unlocked."
- "Gợi ý một nhiệm vụ phù hợp để luyện viết prompt."
- "Mình bí ở bước 2, cho mình gợi ý nhỏ thôi."
- "Kiểm tra lại bài của mình trước khi nộp."
