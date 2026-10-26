# Phase 3 implementation report: ai-tutor analyzer, queue, AI budget (#25)

## Executed phase
- Phase: phase-03-ai-tutor-analyzer-queue-budget
- Plan: plans/261026-2235-25-ai-tutor-insights/
- Branch: feat/25-insights-phase-3 (from origin/main after phase 0, #29)
- Status: completed

## Files
| File | Lines | What |
|---|---|---|
| src/lib/insights/event-queue.ts | 240 (new) | Leased window queue: `findReadyWindows`, `claimWindow`, `skipWindow`, `failWindow`, `deferWindow`, `completeWindow`, `skipStaleEvents` |
| src/lib/insights/turn-filters.ts | 99 (new) | Pure trivial/duplicate/no_value filters, `platformTouch` |
| src/lib/insights/insights-quotas.ts | 59 (new) | Per learner / session / global UTC-day counts, next-day retry time |
| src/lib/insights/ai-tutor-report-schema.ts | 208 (new) | zod + JSON schema, evidence-ref/mission checks, hidden-reasoning lint, stored-report provenance, `PROMPT_VERSION = 1` |
| src/lib/insights/ai-tutor-prompt.ts | 94 (new) | System/user messages, every event and the prior summary fenced as untrusted data, Vietnamese output |
| src/lib/insights/analyzer-stage.ts | 239 (stub replaced) | `runAnalyzerStage(env, budget, now, deps?)` |
| src/lib/coach/ai-gateway.ts | +5/-2 | `AiPurpose` gains `'insights'`; doc comment of `budgetPool` (no logic change, insights → coaching) |
| tests/unit/insights-{turn-filters,report-schema,event-queue,analyzer-stage,ai-budget}.test.ts | 751 (new) | 49 tests |
| tests/unit/insights-pipeline-job.test.ts | 1 line | See cross-phase requests (approved by the coordinator) |

No migration added; 0008 is enough.

## Behaviour
- ai-tutor is described everywhere as a server-side background analyzer: one structured `runAi` call per window, purpose `insights` (coaching pool), no tools, no agent loop. The request body carries no `tools`/`tool_choice`; the only network call is the model call.
- Queue: a window is ready when all its pending events passed `next_attempt_at` (ingest debounce) or it holds ≥ 5 fresh events (attempts = 0, so retry backoff is never shortened). Claim leases for 5 min and counts an attempt; at most 10 events / 48 KB per window, overflow released with the attempt given back. Every update is `WHERE lease_id = ?`, so a reclaimed lease makes the stale worker's writes no-ops (tested).
- Failures: backoff 15/30/60 min (computed in SQL per row), 4th failure → `dead`, payload NULLed. Budget refusal from `runAi` → `deferWindow(now+15m)` with the attempt restored, and the stage stops. Learner quota spent → deferred to 00:05 UTC next day. Session quota (3) → `skipped:quota_session`. Global quota (200) → stage stops before claiming.
- Stale: `skipStaleEvents` marks pending (or lease-expired) events received over 48 h ago as `skipped:stale` with payload NULL. The analyzer runs it each tick so the queue never analyses stale data, whatever retention does.
- Consent: `findReadyWindows` and `claimWindow` join `insight_consents.analysis = 1` and `learners.deleted_at IS NULL`. `completeWindow` is one batch: guarded `INSERT … SELECT … WHERE EXISTS(consent) AND EXISTS(our lease)`, then events → done only if the report exists, then DELETE of the leased events if consent is gone. Revoked between claim and write → 0 reports, events deleted (tested).
- Report validation: required `relevant`, `intent_summary{text, confidence}`, `confidence`, all lists and nullable objects. Items with an evidence ref outside e1…eN, an unknown skill, or an unknown area/mission are dropped; an unknown `mission_id` is removed. Any text matching chain-of-thought / hidden reasoning (EN + VI) rejects the whole output, so the gateway falls through to the next model (tested: OpenRouter output rejected, Workers AI used). Stored `report_json` adds `source_runtime, created_at, model, prompt_version, evidence_refs`, validated by `storedAiTutorReportSchema`.
- Product gate (deterministic): `product_observation` is dropped without `platformTouch` and always when `personal_preference`.
- Limits: ≤ 8 model calls per tick, the stage starts or continues only with ≥ 40 subrequests and ≥ 30 s left plus `canAfford({d1:12, net:3})`, charged per window. AI timeout is 20 s.
- Counting "analyses": written reports **plus** windows the model judged `not_learning` (same model cost). This is slightly stricter than the plan's "count insight_reports" and stops irrelevant traffic from bypassing the daily caps.
- Per-event skip reasons: filtered events keep their own reason (`trivial`, `duplicate`, `no_value` for unreadable payloads) rather than one window-level `no_value`.

## Tests
- `bun run test`: 586/587 pass. The only failure is `insights-redaction.test.ts` "32 KB adversarial input under 50 ms", a timing flake under the full parallel run on this loaded machine. It passes alone (55/55), the code is untouched by this phase, and PR #30 (`fix/redaction-timing-test`) fixes it.
- All `coach-*` suites unchanged and green.
- `bun run content:check`, `bun run migrations:check`, `bun run build` (astro check 0 errors): pass.
- No real AI calls: OpenRouter via injected `fetchImpl` mock, Workers AI via the fake `env.AI.run`; a test also stubs global `fetch` to fail and asserts it was never called.
- Test matrix items covered: retry/backoff/dead-letter, lease reclaim and stale-worker guard, budget refusal keeps attempts, stale 48 h, duplicates, opt-out mid-flight (queue level and during the model call), prompt injection (forged boundary stripped, text stays fenced, obeyed observation dropped, only OpenRouter called), no chain-of-thought claims, evidence refs, nested loops (no process/GitHub/ingest imports, no own fetch), budget pool, coach share spent vs grading, learner cap 12 → next UTC day, abrupt end.
- Not run: the manual `wrangler dev` + `__scheduled` check from the success criteria (needs a real `OPENROUTER_API_KEY`; out of scope for an isolated worktree without production access).

## Cross-phase requests
1. `tests/unit/insights-pipeline-job.test.ts` (phase 0 file, coordinator approved): the "runs the real stubs" case now expects `analyzer: { status: 'failed', error: expect.any(String) }` because the real stage needs `env.DB`. Phases 1 and 5 need the same one-line change for retention and proposal.
2. Phase 1 (`retention-stage.ts`) may import `skipStaleEvents` from `event-queue.ts` instead of writing its own stale sweep; both are idempotent, so running both is harmless.
3. Phase 1 (`ingest-service.ts`): `parseQueuedTurn` accepts `payload_json` as the whole validated v1 body or just its `turn`. `payload_bytes` must be set (the 48 KB window cap uses it), and `next_attempt_at`, `turn_ended_at` and `received_at` must be `Date#toISOString()` strings, because the queue compares them as text.
4. Phase 4/5: reports carry `report_json` = `StoredAiTutorReport`; `has_product_observation = 1` only after the deterministic gate. `skills_json` is the unique list of `learning_insights[].skill`.
5. Phase 6: `AnalyzerStageResult` (`analysed, skipped{reason:n}, deferred, failed, dead, revoked, aiCalls, stopped?`) is the stage's logged result and can feed the operator dashboard.

## Unresolved questions
- The Workers AI fallback inside `runAi` uses its fixed 30 s `WORKERS_AI_TIMEOUT_MS`, not the request's 20 s (gateway logic was out of scope). A tick with a slow OpenRouter call followed by a slow fallback can therefore spend about 50 s on one window. The `remainingMs ≥ 30 s` check before each window bounds the damage. Should the gateway honour `timeoutMs` for Workers AI too?
- A learner deleting their own reports (phase 4) lowers their daily count. That is acceptable at a cap of 12, but it needs confirmation.
