# Phase 1: Ingest API, consents, device pairing, privacy

Effort 8h · Depends on: 0 · Parallel with: 2, 3, 4, 5 · Status: pending

## Context

This phase is the server half of "validate consent & event → sanitize + enqueue → return immediately". The hook is a non-browser client authenticating with a bearer ingestion token. It must not go through the cookie/session middleware path.

Evidence:
- `learnerPolicy` (`src/lib/identity/request-policy.ts:24-38`) would *create a guest* for a POST from a non-bot UA such as Node's `fetch` on any path outside its exemptions. `/api/ingest` must therefore return `'none'`.
- The same-origin rule applies only to `/api/v1` (`src/middleware.ts:28-30`). Ingest lives under `/api/ingest/v1`, so it handles its own Origin rejection.
- Rate limiters are reusable through `allowByLimiter` (`src/lib/identity/request-rate-limits.ts`, bindings `RL_WRITE_IP` and `RL_WRITE_LEARNER` in `wrangler.jsonc`).
- `requireLearner` / `requireObserverAdmin` (`src/lib/privacy/learner-route-context.ts:17,26`) and `readBody` / `apiError` (`src/lib/http/api-response.ts:8-34`) are reused as-is.
- The KV `CACHE` binding holds short-lived state (`wrangler.jsonc` kv_namespaces).

## Requirements

- Three consents: read, patch, and revoke. Revoking `analysis` purges `pending`/`processing` events in the same D1 batch.
- Device pairing: start/poll (bearer-less, rate-limited by IP) and confirm (web session, member only, feature enabled).
- Ingest `POST /turns`, as specified in the phase 0 contract.
- Status endpoint for the doctor, and self-revoke for uninstall `--purge`.
- Learner device list and revoke from Settings.
- Retention stage (fills the phase 0 stub).
- Every route calls `insightsEnabledFor(env, learner)` first and returns `404 not_found` when it is false.

## Files to create

| File | Responsibility |
|---|---|
| `src/lib/insights/consent-store.ts` | `getConsents(db, learnerId)`. `setConsents(db, learnerId, patch)`: an UPSERT plus, when `analysis` goes 1→0, a `DELETE FROM insight_events WHERE learner_id=? AND status IN ('pending','processing')` in the **same** `db.batch`, and a `recordEventSafe` `consent.granted`/`consent.revoked` with `props:{kind:'insights_analysis'|...}`. That needs adding `kind` to props only; `EventName` is unchanged. Also exports `CONSENT_SQL` fragments (`analysisConsented('r')`) for phases 3–5 to reuse. |
| `src/lib/insights/ingest-tokens.ts` | `mintToken()` returns `aiu_ing_` plus 32 random bytes base64url. `hashToken` (SHA-256 hex, as session tokens do). `createToken(db, learnerId, label, adapter)` with a 90-day expiry. `resolveToken(db, raw)` joins `learners` (`deleted_at IS NULL`, `kind='member'`) and returns `{tokenId, learner}` or null. `touchToken` updates `last_used_at` at most once an hour. `listTokens` and `revokeToken(db, learnerId, id)`. |
| `src/lib/insights/device-pairing.ts` | KV `CACHE` keys `insights:pair:dev:<sha256(deviceCode)>` → `{userCode, label, adapter, status:'pending'|'approved'|'denied', learnerId?}` and `insights:pair:user:<userCode>` → device hash, both with TTL 600. `userCode` is 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, formatted `XXXX-XXXX`. `approve(learnerId, userCode)`. `poll(deviceCode)`: when approved, it **deletes both keys before minting** and then mints, so the token is returned exactly once. |
| `src/lib/insights/ingest-auth.ts` | `authenticateIngest(request, env)`: rejects any request with an `Origin` header (403 `origin_forbidden`), parses the bearer, calls `resolveToken`, checks `insightsEnabledFor`, and applies the per-IP limiter `RL_WRITE_IP` with key `ingest:<ip>` and the per-learner limiter `RL_WRITE_LEARNER` with key `ingest:<learnerId>` |
| `src/lib/insights/ingest-service.ts` | `ingestTurn(env, auth, body, now)`. It validates with `ingestTurnV1Schema`, checks `sentAt` within ±10 min, and checks analysis consent (403 `consent_required`). It re-runs `redactValue` from `skills/ai-unlocked/scripts/lib/redact.mjs` server-side and adds the counts. It caps strings again and enforces a daily count cap (200 per learner, counted from `insight_events.received_at`), then writes one statement: `INSERT INTO insight_events (…) SELECT … WHERE EXISTS (SELECT 1 FROM insight_consents WHERE learner_id=? AND analysis=1) ON CONFLICT(learner_id, idempotency_key) DO UPDATE SET payload_json=excluded.payload_json, payload_bytes=excluded.payload_bytes, redactions=excluded.redactions WHERE insight_events.status='pending'`. A re-fire for the same turn (for example after another hook forced a continuation) replaces a still-pending payload, and anything else is a no-op answered with `duplicate:true`. The consent check and the insert are one statement, so a concurrent revoke cannot be outrun. 0 changes plus no existing row means consent is missing → 403. |
| `src/lib/insights/retention-stage.ts` | (Replaces the stub.) Deletes reports with `expires_at < now`, and events in `done`/`skipped`/`dead` older than 7 days. It NULLs `payload_json` on `dead` rows. Events still `pending` after 48 h become `skipped`/`stale` with the payload NULLed. Signals with no evidence left and no proposal are deleted. Each step is bounded by `LIMIT 500` and charged to the budget (1 subrequest per statement). |
| `src/pages/api/ingest/v1/turns.ts` | `POST` → `authenticateIngest` → `ingestTurn` → 202 |
| `src/pages/api/ingest/v1/status.ts` | `GET` (bearer) |
| `src/pages/api/ingest/v1/token.ts` | `DELETE` (bearer, self-revoke) |
| `src/pages/api/ingest/v1/pair/start.ts`, `pair/poll.ts` | IP-limited (`RL_WRITE_IP`, key `pair:<ip>`); poll is also limited to 1 per 4 s per device code via KV |
| `src/pages/api/v1/insights/settings.ts` | `GET` → `{enabled, member, consents, devices:[{id,label,adapter,createdAt,lastUsedAt,expiresAt}], queue:{pending, lastReceivedAt}, retentionDays}` |
| `src/pages/api/v1/insights/consent.ts` | `PATCH {analysis?, shareOperator?, proposals?}` → `{consents}`. Turning `shareOperator` or `proposals` on requires `analysis` = 1 (otherwise 400 `invalid`). Turning `analysis` off forces the other two off in the same batch. |
| `src/pages/api/v1/insights/pair/confirm.ts` | `POST {userCode, approve:boolean}`; member only (guest → 403 with a sign-in message); per-learner limiter `RL_WRITE_LEARNER` with key `pair:<id>`; a wrong code → 404 |
| `src/pages/api/v1/insights/tokens/[id].ts` | `DELETE` → revoke own device (another learner's id → 404) |
| Tests | `tests/unit/insights-ingest-service.test.ts`, `insights-ingest-auth.test.ts`, `insights-ingest-consent.test.ts`, `insights-device-pairing.test.ts`, `insights-retention-stage.test.ts` |

## Files to modify

| File | Change |
|---|---|
| `src/lib/identity/request-policy.ts` | Add `startsWithSegment(pathname, '/api/ingest')` to the `'none'` branch (`:25-28`) |
| `tests/unit/identity-request-policy.test.ts` | One case: `/api/ingest/v1/turns` POST with a Node UA → `'none'` (phase 1 owns this edit) |

## Data flow

Hook → `POST /api/ingest/v1/turns`. The worker (`src/worker.ts:26`) passes it to the OAuth provider's default handler and on to Astro. The middleware gives policy `none`, so no session and no same-origin check apply (the path is not `/api/v1`). Then:
1. `authenticateIngest`: Origin check → bearer → `insight_tokens` joined to `learners` → flag check → limiters.
2. `ingestTurn`: zod → time window → server redaction → one guarded INSERT.
3. Response 202.

A row lands in `insight_events` as `pending` with `next_attempt_at = now + 5 min` (debounce, see phase 3).

Pairing: CLI `pair/start` → the user opens `verificationUri?code=XXXX-XXXX` (phase 4 page) → `POST /api/v1/insights/pair/confirm` (same-origin cookie session) → KV status `approved` → CLI `pair/poll` → token, returned once → written to a 0600 file (phase 2).

## Security notes

- **CSRF.** Ingest reads no cookies and rejects any `Origin` header. `pair/confirm` sits under `/api/v1` and gets the existing same-origin rule.
- **Replay.** The idempotency key acts as a nonce per learner, and `sentAt` must be within ±10 minutes. TLS is enforced by the custom domain.
- **Isolation.** The learner comes from the token row and never from the body.
- **Brute force.** User codes have 32^8 combinations with a 10-minute TTL, and confirm is limited to 30 per minute per learner.
- **Audit.** Consent changes are recorded through `events` (`consent.granted`/`consent.revoked` with `kind`).

## Steps

1. Build `consent-store`, `ingest-tokens`, and `device-pairing` with their unit tests (`createTestD1`, an in-memory KV fake following the existing tests' pattern).
2. Build `ingest-auth` and `ingest-service`, then the routes, then the request-policy edit.
3. Build the settings, consent, confirm, and tokens routes.
4. Build the retention stage and its test with a fake `CronBudget` (`createCronBudget({subrequests})`).
5. `bun run test` and `bun run build`.

## Tests (must cover)

- Consent: defaults are all 0. Turning `shareOperator` on without `analysis` → 400. Revoking analysis purges pending events and forces the other two off. Ingest after revoke → 403, with zero rows added.
- Opt-out mid-flight (ingest side): consent revoked between auth and insert → the guarded INSERT writes 0 rows and the route answers 403.
- Duplicate Stop: the same key twice → one row and `duplicate:true`. A re-fire while pending replaces the payload; while done it is a no-op.
- Replay: stale `sentAt` → 400. Revoked token → 401. Expired token → 401. An `Origin` header → 403.
- Cross-user: A's token cannot write to B even with B's id in the body (there is no such field; the schema is `.strict()`). Revoking B's token through A's session → 404.
- Server redaction: a body containing `sk-ant-…`, an email, and a VN phone is stored masked, and `redactions` is incremented.
- Size: 33 KB body → 400. The feature off for this learner → 404 (indistinguishable from an unknown route).
- Pairing: approve → the first poll returns the token and the second poll gets 410. Expired → 410. Denied → 410. A guest confirm → 403. A wrong code → 404.
- Retention: TTL deletes, dead payloads are NULLed, 48 h pending → `skipped:stale`, and the budget is charged.

## Success criteria

All listed tests pass. No change to existing route behaviour: the `api-v1-routes`, `identity-*`, and `privacy-data-rights` suites stay green.

## Risks

| Risk | L × I | Mitigation |
|---|---|---|
| KV eventual consistency loses an approval between confirm and poll | M × L | The CLI keeps polling until `expiresIn`. KV reads converge within seconds, and the 10-minute TTL covers that. |
| Token leaked from the user's machine | L × M | Scope is write-only, so a leaked token cannot read data. It is revocable per device, expires in 90 days, and is rate-limited. |
| Consent check and insert race | L × H | Done in a single SQL statement (`INSERT … SELECT … WHERE EXISTS`) |

## Rollback

Revert the PR, or set `INSIGHTS_MODE=off`. While the mode is off, the routes 404 and nothing is written.
