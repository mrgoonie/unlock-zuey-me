# Phase 1 report: ingest API, consents, device pairing, privacy (#25)

Status: completed. Branch `feat/25-insights-phase-1`. No new migration; 0008 covers everything.

## What was built

| File | Notes |
|---|---|
| `src/lib/insights/consent-store.ts` | `getConsents`, `setConsents` (one UPSERT whose SQL enforces "share_operator/proposals only while analysis = 1"; revoking analysis purges `pending`/`processing` rows in the same `db.batch`, guarded by the row just written), `consent.granted/revoked` events with `props.kind`, `CONSENT_SQL.{analysis,shareOperator,proposals}Consented(alias)` fragments for phases 3–5 |
| `src/lib/insights/ingest-tokens.ts` | `mintToken`, `hashToken` (SHA-256 hex only), `createToken` (INSERT…SELECT from active members, 90 days), `resolveToken` (joins learners: member, not deleted or merged), `touchToken` (at most hourly), `listTokens`, `revokeToken` |
| `src/lib/insights/device-pairing.ts` | KV keys `insights:pair:{dev,user,poll}:…`, raw device code never stored, `expiresAt` enforced in the record, approval deletes both keys before minting, separate poll key so a poll cannot overwrite an approval, `peekPairing` for the phase 4 page |
| `src/lib/insights/ingest-auth.ts` | `guardIngestRequest` (mode off → 404 before anything, Origin → 403, per-IP `RL_WRITE_IP`), `authenticateIngest` (bearer → token → `insightsEnabledFor` → per-learner `RL_WRITE_LEARNER`), `requireInsightsLearner` for the `/api/v1/insights` session routes |
| `src/lib/insights/ingest-service.ts` | Streamed body cap (32 KB), strict v1 schema, ±10 min `sentAt`, consent pre-check, server `redactValue` on `turn` only, field caps re-applied after redaction, one guarded `INSERT … SELECT … WHERE EXISTS(consent) AND daily count < 200 ON CONFLICT … DO UPDATE … WHERE status='pending'` |
| `src/lib/insights/retention-stage.ts` | Replaces the stub: report TTL, 48 h pending → `skipped/stale`, NULL payloads of done/skipped/dead, delete those after 7 days, prune orphan signals; `LIMIT 500` per step and 1 D1 query charged per step |
| `src/pages/api/ingest/v1/{turns,status,token}.ts`, `pair/{start,poll}.ts` | As in the contract; pairing bodies capped at 1 KB |
| `src/pages/api/v1/insights/{settings,consent}.ts`, `pair/confirm.ts`, `tokens/[id].ts` | Session routes; same-origin rule from the middleware applies |
| `src/lib/identity/request-policy.ts` | `/api/ingest` → `'none'` |

Tests: `insights-ingest-{service,auth,consent,device-pairing}.test.ts`, `insights-retention-stage.test.ts`, shared doubles in `insights-ingest-fixtures.ts`, one case in `identity-request-policy.test.ts`.

## Decisions worth checking

- **Gate order on ingest routes:** `INSIGHTS_MODE=off` returns 404 before the Origin check, so the routes look absent. After that the order is Origin (403), then the IP limit, then the token (401), then the per-learner feature check (404), then the learner limit (429).
- **Origin rejection also covers `pair/start` and `pair/poll`.** All `/api/ingest/**` routes are for non-browser clients only.
- **Daily cap is enforced inside the guarded INSERT.** There is no separate pre-check. When nothing is written, the reason is chosen in this order: consent missing (403), then row already exists (`duplicate:true`), then the cap (429). So a re-fire at the cap answers `duplicate:true`.
- **Session routes:** with the mode off, everything returns 404. A guest gets 404, except on `pair/confirm`, which answers 403 with a sign-in message as the plan asks. With no session the answer is 401.
- **`/status` versions:** `serverVersion` comes from `INGEST_SERVER_VERSION` = `1.0.0`. `latestSkillVersion` comes from `LATEST_SKILL_VERSION` = `0.1.0` in `ingest-service.ts`. See the cross-phase requests below.
- **Rate limits:** I made no change to `request-rate-limits.ts`. The routes call `allowByLimiter` themselves with the keys `ingest:<ip>`, `ingest:<learnerId>`, `pair:<ip>` and `pair:<learnerId>`.

## Cross-phase requests

1. **Phase 0 test, `tests/unit/insights-pipeline-job.test.ts`:** I changed only the retention line, as the orchestrator allowed. The real stage needs `env.DB`, so the expectation is now `{status:'failed', error: expect.any(String)}`.
2. **Phase 0 test, `insights-redaction.test.ts` ("32 KB adversarial input under 50 ms each"):** this test is flaky under full-suite or machine load. It measured 59–126 ms in about 3 of 5 full runs and always passes alone. I suggest taking the minimum of a few runs, or raising the CI bound. I did not edit it.
3. **Phase 2 / phase 6:** `LATEST_SKILL_VERSION` needs to read from the skill manifest (`src/lib/skill/skill-bundle.ts`) once that exists, or be checked by a test against `skills/ai-unlocked/manifest.json`.
4. **Phase 4:** the pairing page can use `peekPairing(env.CACHE, code)` to show the label and adapter. The settings panel reads `GET /api/v1/insights/settings`, `PATCH /api/v1/insights/consent` (`{consents}`), `DELETE /api/v1/insights/tokens/:id` (`{revoked:true}`) and `POST /api/v1/insights/pair/confirm` (`{status:'approved'|'denied'}`).
5. **Phase 3:** the payload is stored as `StoredTurnPayload` (exported from `ingest-service.ts`): `{v, adapter, adapterVersion, turn, redaction:{count,kinds}, truncated, stopHookActive}`. Identity, session and timing live in their own columns.

## Unresolved questions

- KV is not transactional. Two polls that both land in the same instant after approval could both read `approved`. The 4 s per-code slow_down key makes this unlikely, but "exactly once" is best-effort across PoPs. A Durable Object would make it strict. I recommend accepting this for v1.
