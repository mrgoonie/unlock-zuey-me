# Content v1 report (module A)

Status: done. Branch `feat/content-v1`. Gates: `bun run content:check` → 8 missions (8 published), 41 concepts, 13 badges, content OK; `bun run test` → 20/20 pass.

## Missions

| id | Title | Min | Risk | Competencies |
|---|---|---|---|---|
| `plan-weekend` | Lên kế hoạch cuối tuần cùng AI | 15 | low | describe, verify, reflect |
| `plan-family-trip` | Lên kế hoạch chuyến đi gia đình | 18 | low | describe, verify, operate, reflect |
| `write-hard-message` | Soạn một tin nhắn khó nói | 12 | low | describe, verify, operate, reflect |
| `compare-before-buying` | So sánh trước khi mua | 15 | medium | describe, verify, delegate, reflect |
| `understand-document-safely` | Hiểu một giấy tờ khó đọc, an toàn | 15 | high | verify, describe, operate, reflect |
| `family-meal-plan` | Thực đơn tuần cho cả nhà, đúng ngân sách | 15 | medium | describe, verify, operate, reflect |
| `summarize-long-text` | Tóm tắt bài dài hay tin nhắn thoại | 12 | low | delegate, verify, describe, reflect |
| `spot-the-ai-mistake` | Bắt lỗi AI | 15 | medium | verify, discover, reflect |

Every mission has guided-input, ai-task, verification (≥4 claims; half cover all four verdicts), reflection, and a quiz and/or prediction step. Each has a 4-level hint ladder per step, a rubric of ≥6 criteria mixing deterministic checks with English AI guidance, and pass_score 0.7. Medium/high risk missions carry safety notes: verify with a professional, never pay via AI-supplied accounts, and call 115 in emergencies. `plan-weekend` and `plan-family-trip` point at each other via `transfer_variant`. `plan-weekend` was otherwise left as is, apart from adding the `knowledge-cutoff` concept ref.

## Concepts (41)

There are 38 new concepts plus the existing context, hallucination and prompt; the `related` lists of those three were extended. They span all 5 groups. Labs are linked on token and next-token-prediction (token-predictor), context and context-window (context-lab), and hallucination (hallucination-detective). `agi` and `ai-vendors-and-models` are current-fact concepts with review_due_at 2027-01-26 and confidence medium. No `source_refs` were added, to avoid unverified URLs.

## Badges (13)

The badges use all 9 rule kinds. They include missions_completed 3/8, mission_completed for spot-the-ai-mistake, competency_score for verify, describe and reflect at 0.8, labs_completed 3, streak_days 3/7, and calibrated within 0.15.

## Tests

- `tests/unit/content-schema.test.ts` used `files.concepts[0]` as a fixture. That broke once `agent-skill.yaml` sorted first, so the test now selects `prompt.yaml` by name.
- `tests/unit/content-catalog.test.ts` is new. It checks editorial invariants: 8 published missions, step count and mix, ≥3 claims, rubric method mix, minutes, pass_score, safety notes on risky missions, reciprocal transfer, concept and group coverage, lab links, current-fact review data, and that all badge kinds are used.

## Notes for other modules

- The verdict labels used in mission copy are "Tin có căn cứ" (verified), "Cần tra cứu" (needs_lookup), "Không đủ dữ liệu" (insufficient) and "Cần chuyên gia" (expert). The UI should show the same labels.
- In the verification steps, a false claim the learner can check is labelled `needs_lookup`, and a claim the source does not support or that the AI invented is labelled `insufficient`. The verdict means "what should you do with this claim", not "true or false". Each claim's explanation states whether it is wrong.
- The `calibrated` badge copy assumes the confidence is entered on a 0–100 scale and `within: 0.15` compares on a 0–1 scale.
- The study-plan mission idea was not used, to keep the total at exactly 8. A candidate for v2.

## Unresolved questions

- The semantics of `transfer_pass` belong to the engine. The content links both directions, so either direction should work.
