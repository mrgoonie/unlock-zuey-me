# Insights ingest contract (v1)

Wire contract between the `ai-unlocked` skill (Claude Code Stop hook and CLI) and the ingest API of unlock.zuey.me (issue #25). The machine-checked source of truth is [`src/lib/insights/ingest-contract.ts`](../src/lib/insights/ingest-contract.ts) (zod schemas, caps, error reasons). Shared types are in [`src/lib/insights/insight-types.ts`](../src/lib/insights/insight-types.ts), flags in [`src/lib/insights/feature-flags.ts`](../src/lib/insights/feature-flags.ts), and the schema in [`migrations/0008_insights.sql`](../migrations/0008_insights.sql). If this page and the code disagree, the code wins and this page is fixed.

## Scope and naming

- **ai-tutor** is a server-side background analyzer: one structured LLM call per debounced session window, run by the 15-minute cron. It is not a Claude Code subagent, and it never sees the model's hidden reasoning. UI copy calls it "bộ phân tích nền ai-tutor trên máy chủ".
- Only signed-in zuey.me **members** can pair a device or upload turns. Guests cannot.
- Every endpoint returns `404` while `INSIGHTS_MODE` does not enable the feature for the learner (see Feature flags).

## Feature flags

| Var | Values | Effect |
|---|---|---|
| `INSIGHTS_MODE` | `off` (default), `internal`, `pilot`, `on` | `off`: every insights route returns 404, the UI is hidden, and the cron job is a no-op that charges nothing. `internal`: admins only. `pilot`: admins plus `INSIGHTS_PILOT_EMAILS`. `on`: all members. An unknown value is `off`. |
| `INSIGHTS_PILOT_EMAILS` | comma- or space-separated emails | Pilot list, compared case-insensitively. |
| `INSIGHTS_RETENTION_DAYS` | integer 1–3650, default 90 | Report TTL (`insight_reports.expires_at`). Queue rows are kept 7 days. |
| `INSIGHTS_DAILY_ANALYSES_PER_LEARNER` | default 12 | ai-tutor analyses per learner per UTC day. At most 3 per session per day. Counted from processed queue rows, so deleting reports does not free the quota. |
| `INSIGHTS_DAILY_ANALYSES_GLOBAL` | default 200 | ai-tutor analyses across all learners per UTC day. |
| `INSIGHTS_GITHUB_ISSUES` | `off` (default), `issues`, `issues_ai_handle` | Effective mode is `off` whenever the `GITHUB_ISSUES_TOKEN` secret is missing **or** `INSIGHTS_MODE` is `off`, whatever the var says. |
| `INSIGHTS_GITHUB_REPO` | `owner/repo` | Default `mrgoonie/unlock-zuey-me`. |
| `GITHUB_ISSUES_TOKEN` (secret) | fine-grained PAT, Issues: write on that repo only | Server-side only. It never reaches the hook, the client bundle, a response, or a log line. |

`insightsEnabledFor(env, learner)` is the single gate every route, page and stage calls first.

## Authentication

- Ingest endpoints take `Authorization: Bearer aiu_ing_<43 base64url chars>`, a device ingestion token minted by pairing. The server stores only its SHA-256 hex (`insight_tokens.token_hash`). The token has scope `insights:write`, expires after 90 days, and can be revoked per device. A learner holds at most 10 active tokens (`MAX_ACTIVE_TOKENS_PER_LEARNER`): minting an 11th revokes the oldest active one (`revoked_at`), and Settings lists every active token. It is not an OAuth token, and `MCP_SCOPES` does not change.
- The token binds the learner. No request body can name a learner.
- Any request carrying an `Origin` header is rejected with `403 origin_forbidden`, because ingest is for non-browser clients only. `/api/ingest/**` is outside the cookie session middleware (`learnerPolicy` returns `'none'`) and outside the `/api/v1` same-origin rule.
- On the client, the token lives in `${XDG_CONFIG_HOME:-~/.config}/ai-unlocked/credentials.json` (file 0600, dir 0700; `%APPDATA%\ai-unlocked` on Windows). `AI_UNLOCKED_INGEST_TOKEN` overrides it. The token is never printed, logged, written to `settings.json`, or written to the project directory.

## `POST /api/ingest/v1/turns`

Body: JSON, at most `INGEST_MAX_BYTES` = 32,768 bytes (UTF-8, checked before parsing). The client aims for `CLIENT_TARGET_BYTES` = 16,384 by trimming the assistant text first.

```json
{
  "v": 1,
  "adapter": "claude-code",
  "adapterVersion": "0.1.0",
  "idempotencyKey": "<sha256 hex of session_id + ':' + (prompt_id || sha256(last_assistant_message))>",
  "sessionRef": "<sha256 hex of session_id + installSalt>",
  "sentAt": "2026-10-26T16:00:00.000Z",
  "turnEndedAt": "2026-10-26T15:59:58.000Z",
  "turn": {
    "userPrompt": "string or null (≤ 4000 chars)",
    "assistantFinal": "string (≤ 6000 chars)",
    "tools": [{ "name": "mcp__ai-unlocked__start_mission", "ok": true, "count": 1 }],
    "platform": { "mcpTools": ["start_mission"], "missionId": "plan-weekend", "runId": "run_…" }
  },
  "redaction": { "count": 2, "kinds": ["email", "api_key"] },
  "truncated": false,
  "stopHookActive": false
}
```

Field rules (`ingestTurnV1Schema`):

- The payload is **strict**: unknown fields at any level are rejected. The client never sends `cwd`, `permission_mode`, file contents, or tool arguments and results. Adding a field requires `v: 2`.
- `adapter` is one of `INGEST_ADAPTERS` (`claude-code`). `adapterVersion` is semver.
- `idempotencyKey` and `sessionRef` are lowercase 64-char SHA-256 hex. The raw session id never leaves the machine.
- `sentAt` and `turnEndedAt` are ISO 8601 with an offset. `sentAt` must be within ±10 minutes of the server clock.
- `turn.userPrompt` is `null` when the transcript could not be parsed. `turn.assistantFinal` is Claude Code's `last_assistant_message`.
- `turn.tools`: at most 50 entries `{name, ok, count}`. `name` matches `[A-Za-z0-9_.:-]{1,128}`. `ok` is false if any call errored. `count` is 1–1000. Arguments and outputs are never sent.
- `turn.platform` is optional. `mcpTools` holds unlock.zuey.me MCP tool names without the `mcp__<server>__` prefix (`[a-z0-9_]{1,64}`, at most 20). `missionId` is kebab-case and `runId` matches `run_…`.
- `redaction.kinds` entries match `[a-z_]{1,32}` (at most 32), so a newer client never fails validation on an older server.
- `stopHookActive` mirrors Claude Code's `stop_hook_active`.

Server processing, in this order (`ingest-auth.ts`, `ingest-service.ts`):

1. `INSIGHTS_MODE` off → `404 feature_off`, before anything else, so the route looks absent.
2. An `Origin` header → `403 origin_forbidden`.
3. Per-IP limit (`RL_WRITE_IP`, key `ingest:<ip>`) → `429 rate_limited`, before any D1 lookup.
4. Bearer token → learner (member, not deleted or merged) or `401 unauthorized`. The feature must be enabled for that learner (`404 feature_off`), then the per-learner limit applies (`RL_WRITE_LEARNER`).
5. Body read as a stream and cut at 32,768 bytes (`payload_too_large`), UTF-8 and JSON, strict schema (`invalid_payload`), `sentAt` window (`clock_skew`).
6. Analysis consent (`403 consent_required`).
7. **Server-side redaction** of `turn` with the same rule set. Free text is masked and re-capped. An identifier the rules flag cannot hold a placeholder, so it is dropped instead: a tool or MCP tool name is removed, `missionId` / `runId` become `null`.
8. One guarded `INSERT … SELECT … WHERE EXISTS (analysis consent) AND (today's count < 200) ON CONFLICT (learner_id, idempotency_key) DO UPDATE … WHERE status = 'pending'`. A re-fire for the same turn replaces a still-pending payload; anything else is a no-op answered `duplicate: true`. When nothing was written the answer is chosen in this order: consent gone (`403`), row already exists (`duplicate: true`), daily cap (`429 daily_cap`).

The stored row keeps `payload_json = {v, adapter, adapterVersion, turn, redaction, truncated, stopHookActive}` (identity, session and timing live in their own columns). The event becomes ready for analysis 5 minutes after it was received (`INGEST_DEBOUNCE_MS`), which debounces a session.

### Responses

Success: `202 {"accepted": true, "duplicate": boolean}`.

Errors use the shared shape plus a machine-readable `reason` (`INGEST_ERROR_REASONS`):

```json
{ "error": { "code": "forbidden", "message": "Vietnamese text", "reason": "consent_required" } }
```

| Status | `code` | `reason` | When | Hook behaviour |
|---|---|---|---|---|
| 401 | `unauthorized` | `unauthorized` | Token missing, malformed, unknown, revoked, or expired | Mark credentials invalid, keep the spool, stop uploading until re-paired |
| 403 | `forbidden` | `consent_required` | Analysis consent is off | Delete the spool, back off 1 h |
| 403 | `forbidden` | `origin_forbidden` | An `Origin` header is present | Client bug; drop the item |
| 404 | `not_found` | `feature_off` | The feature is not enabled for this learner | Delete the spool, back off 24 h |
| 400 | `invalid` | `invalid_payload` | Not JSON, or the schema fails | Drop the item |
| 400 | `invalid` | `payload_too_large` | Body over 32,768 bytes | Drop the item |
| 400 | `invalid` | `clock_skew` | `sentAt` outside ±10 min | Rebuild `sentAt` and retry once |
| 429 | `rate_limited` | `rate_limited` | Per-IP or per-learner request limit | Keep the spool, retry later |
| 429 | `budget_exceeded` | `daily_cap` | 200 accepted turns per learner per UTC day | Keep the spool, retry after 00:00 UTC |

Any 5xx or network error keeps the spool for the next flush.

## Other ingest endpoints

| Method and path | Auth | Body | Response |
|---|---|---|---|
| `GET /api/ingest/v1/status` | bearer | none | `200 {feature: true, consents: {analysis}, token: {label, expiresAt}, serverVersion, latestSkillVersion}` |
| `DELETE /api/ingest/v1/token` | bearer | none | `200 {revoked: true}`, revokes the calling token (`uninstall --purge`) |
| `POST /api/ingest/v1/pair/start` | none, IP-limited | `{label (1–64 chars), adapter}` | `200 {deviceCode, userCode, verificationUri, interval: 5, expiresIn: 600}` |
| `POST /api/ingest/v1/pair/poll` | none, IP-limited | `{deviceCode}` | `428 {status: "pending"}`, `200 {token, expiresAt}` (exactly once), `410 {status: "expired" \| "denied"}`, `429 rate_limited` with reason `slow_down` when polled faster than every 4 s |

All five endpoints share steps 1–3 above (feature, Origin, per-IP limit; the pairing endpoints use the key `pair:<ip>`). Pairing bodies are capped at 1 KB. `verificationUri` is built from `PUBLIC_SITE_URL`.

The device code stays an opaque 43-character base64url string to the client. The server builds it from the user code (8 characters, no dash) plus 35 random characters and keeps one KV record per pairing, keyed by the user code and holding only the SHA-256 of the whole device code. `pair/start` therefore costs one KV write, a poll whose code does not match a live record writes nothing, and only a known code's poll records its poll time (for `slow_down`).

## Device pairing flow

1. The CLI calls `pair/start` and shows `userCode` (8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, displayed `XXXX-XXXX`) and `verificationUri` (`https://unlock.zuey.me/insights/pair`) in the terminal.
2. The learner opens the page while signed in and approves or denies the code: `POST /api/v1/insights/pair/confirm {userCode, approve}`. This needs the web session, member only, and the feature enabled. Input is upper-cased and the dash is optional (`normalizeUserCode`).
3. The CLI polls `pair/poll` every 5 s. On approval the server deletes the pairing record, then mints the token, so it is returned exactly once. The device and user codes expire after 600 s.

The token therefore never passes through the agent chat or transcript.

## Hook behaviour (Claude Code adapter)

- It is a synchronous `command` Stop hook with `timeout: 10`. It reads stdin, redacts, writes a 0600 spool file, spawns a detached uploader, and exits 0 with **empty stdout**. It never emits `decision` or `continue` and never exits 2.
- It ignores payloads with `agent_id` or `hook_event_name: "SubagentStop"`, and exits at once when `AI_UNLOCKED_INTERNAL=1`. The installer never registers SubagentStop.
- When locally paused, without credentials, or inside a server back-off window, it reads no transcript and makes no network call.

## Redaction

[`skills/ai-unlocked/scripts/lib/redact.mjs`](../skills/ai-unlocked/scripts/lib/redact.mjs) is pure, dependency-free JS imported unchanged by the hook (Node ≥ 18) and by the Worker (defense in depth). Types are in `redact.d.mts`.

- `redactText(text) → {text, count, kinds}` and `redactValue(value) → {value, count, kinds}`. `redactValue` redacts strings only and keeps object keys.
- Matches become `[REDACTED:<kind>]`, and home directories become `~`. Running it again on its own output finds nothing, so it is idempotent.
- Kinds: `private_key`, `ingest_token`, `api_key` (sk-, sk-ant-, sk-or-, sk-proj-), `github_token`, `aws_key`, `aws_secret`, `slack_token`, `google_key`, `jwt`, `bearer`, `url_secret`, `secret` (credential-named key = value, including "mật khẩu", and passwords stated in prose: "password is …", "mật khẩu của tôi là …"), `stripe_key` (sk_/rk_/pk_ live or test), `azure_key` (`AccountKey=` / `SharedAccessKey=`, label kept), `url_credentials` (`scheme://user:pass@host`, host kept), `bank_account` (8–19 digits after an STK / số tài khoản / account number label), `email`, `home_path`, `national_id` (CCCD/CMND next to its label, or a standalone 12-digit number), `card` (13–19 digits passing Luhn), `phone` (VN mobile), `iban`, `ip` (except 127.0.0.1 and 0.0.0.0), `high_entropy` (hex ≥ 32 chars, or base64 ≥ 32 chars mixing upper case, lower case and digits).
- Input is capped at 65,536 characters and every quantifier is bounded, so a 32 KB adversarial input runs in well under 50 ms.
- The server applies `redactValue` to the `turn` object only. `idempotencyKey` and `sessionRef` are hashes by design and are not redacted.

## Consents and retention

- `insight_consents` holds `analysis`, `share_operator`, and `proposals`, all 0 by default and separate from `learners.observer_consent`. The pairing approval page (`/insights/pair`) shows the ones not yet on as pre-ticked boxes: analysis (required to approve) and operator sharing (optional; ticking it grants `share_operator` and `learners.observer_consent`, so the box lists everything observer access shows, including in-app coach messages and evidence, and says only ai-tutor report views are audited). The ticked consents travel with the approval (`POST /api/v1/insights/pair/confirm` `grant`) and the server grants them only after checking the code is still pending; a stale or mistyped code grants nothing. Nothing on that page revokes a consent. Turning on `share_operator` or `proposals` requires `analysis`. Turning `analysis` off turns the other two off and purges `pending` and `processing` events in the same batch. Ingest after a revoke returns `403 consent_required`.
- **Aggregates:** operator aggregate dashboards show counts only (no text), require a cohort of at least 3 learners, and cover learners with `analysis` consent. The consent copy discloses this. Signal text comes only from learners with `proposals` consent. Per-learner detail requires `share_operator = 1` and `observer_consent = 1`, and every view writes an `insight_access_audit` row.
- **Retention:** reports are kept for `INSIGHTS_RETENTION_DAYS` (90). Queue rows in `done`, `skipped`, or `dead` are deleted after 7 days. `payload_json` is NULLed as soon as an event is processed, skipped, or dead. Pending events older than 48 h become `skipped` with reason `stale`.
- Export and delete cover `insight_consents`, `insight_tokens` (without `token_hash`), `insight_events`, `insight_reports`, and `insight_access_audit` through `LEARNER_TABLES` (`src/lib/privacy/learner-data-tables.ts`). `insight_signal_evidence` cascades from `insight_reports`. `insight_signals`, `insight_proposals`, and `insight_operator_settings` hold no learner column.

## After ingest (server pipeline)

The `insights-pipeline` cron job (`src/lib/insights/pipeline-job.ts`, last job of the 15-minute tick) runs retention → analyzer → proposals on the shared cron budget. With `INSIGHTS_MODE=off` it returns `{skipped: "flag_off"}` and charges nothing.

- **Analyzer** (`analyzer-stage.ts`, `event-queue.ts`): a session window is ready once all its pending events are past the debounce, or it holds ≥ 5 fresh events. A claim leases it for 5 minutes from the moment of the claim, even late in a cron run (at most 10 events / 48 KB). Trivial and duplicate turns are skipped before any model call. Quotas: 12 analyses per learner, 3 per session and 200 overall per UTC day (counted from the `done` and `not_learning` queue rows, which deleting reports leaves in place), at most 8 model calls per tick, 20 s per call. Failures back off 15 / 30 / 60 minutes and the 4th failure dead-letters the events with the payload NULLed. An AI budget refusal defers the window without spending an attempt. The report write is one batch guarded by analysis consent and the lease, so a revoke at any point leaves no report; a window dropped that way (consent off, all or some of its queued turns deleted, or account deleted) is counted as `revoked`, not as a lost lease. Model calls are charged to the `system:insights` row of `ai_usage` in the coaching pool, never to the learner's own coaching share (see [insights-rollout.md](insights-rollout.md)).
- **Reports** carry provenance (`source_runtime`, `model`, `prompt_version`, evidence refs, window bounds) and only observable facts; any text claiming hidden reasoning rejects the model output.
- **Proposals** (`proposal-stage.ts`): only reports of learners with `proposals` consent written after that consent are linked to a fingerprinted signal. A signal becomes a dashboard proposal at 3 distinct consenting learners (every category) with confidence ≥ 0.6. Automatic filing of a GitHub issue additionally needs the effective GitHub mode (`issues` or `issues_ai_handle`, which requires the token), low risk with no denylist hit, ≥ 3 learners, confidence ≥ 0.75, a clean privacy re-scan of the issue body and the daily cap of 3. `ai-handle` also needs `issues_ai_handle`, a `content` or `bug` category and the operator's `safe_auto_implement`. Risk is computed from controlled fields; model text can only raise it. An operator may accept and file a proposal the gate kept at the proposal tier because of its risk, but never past the evidence gate (cohort, confidence, personal preference), the privacy check, the daily cap or the `ai-handle` mode requirement. See `proposal-policy-gate.ts`.
- **Drafts and consent** (`proposal-assessment.ts`, `proposal-filing.ts`): every filing path (cron, accepted, operator) recomputes the consented cohort and the gate right before filing. A draft records the reports it was written from (`basis`). When any of them is no longer consented evidence (consent revoked, reports or account deleted) the draft is rebuilt from the template; when fewer than 3 consenting learners remain, the draft is withdrawn (`draft_json = '{}'`), the proposal returns to `proposed` and nothing is filed or shown. The cron also refreshes stale drafts of open, rejected and duplicate proposals. Drafts never quote evidence: the prompt forbids it, and the re-scan rejects a draft sharing a 40-character normalized run (accents and punctuation folded) or 8 consecutive words with the evidence; a rejected model draft is replaced by the template.
- **Filing lease:** a filing holds a 2-minute lease. An attempt that finds an expired lease first searches GitHub for the fingerprint marker and links the issue it finds; otherwise it releases the proposal to `accepted` (operator-decided) or `proposed` and reports `released`. A released row frees its filing slot; after an ambiguous create the daily slot stays used on purpose, so a create that may have succeeded cannot be repeated the same day.
