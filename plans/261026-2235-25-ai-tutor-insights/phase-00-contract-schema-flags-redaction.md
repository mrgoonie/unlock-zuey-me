# Phase 0: Contract, schema, feature flags, shared redaction

Effort 5h · Depends on: none · Blocks: 1, 2, 3, 4, 5 · Status: pending

## Context

Phases 1–5 must work in parallel without touching each other's files. Every shared seam is therefore fixed here: the D1 schema, TypeScript types, the ingest wire contract, feature flags, the redaction rules, the single cron job entry with its stage stubs, and the privacy table registry. Nothing in this phase changes behaviour, because every flag defaults to `off`.

Evidence:
- The cron dispatcher runs jobs sequentially against a shared budget (`src/lib/jobs/scheduled-jobs.ts:54-95`, `src/lib/jobs/cron-budget.ts:16`).
- Export, delete, and guest cleanup all iterate `LEARNER_TABLES` (`src/lib/privacy/learner-data-tables.ts:21-39`; `delete-learner-data.ts:64`; `export-learner-data.ts:66`; `inactive-guest-cleanup.ts:81`).
- The registry test fails when any `learner_id` table is missing (`tests/unit/privacy-data-rights.test.ts:39`), and the export test expects at least one row per table from the seed fixture (`:61`, `tests/unit/observer-seed-fixtures.ts:10`).
- `Env` is declared in `src/env.d.ts:4`, and the vars live in `wrangler.jsonc` `vars`.

## Requirements

- Additive migration `migrations/0008_insights.sql` (0007 is reserved for in-flight work). No ALTER on existing tables, so it is safe if applied before the worker deploys (#18).
- One source of truth for redaction, usable unchanged by Node ≥ 18 on the learner's machine and by the Worker bundle.
- Feature flag helper that every insights route, page, and stage calls first.

## Files to create

| File | Purpose |
|---|---|
| `migrations/0008_insights.sql` | Schema below |
| `src/lib/insights/insight-types.ts` | `InsightConsents`, `IngestTurnV1` (inferred from zod), `AiTutorReport`, `ProductObservation`, `ProposalCategory`, `ProposalStatus`, `RiskLevel`, `GateDecision`, `InsightsMode` |
| `src/lib/insights/ingest-contract.ts` | zod `ingestTurnV1Schema` + caps (`INGEST_MAX_BYTES=32768`, `CLIENT_TARGET_BYTES=16384`, field caps), `PAIR_*` constants, ingest error `reason` enum |
| `src/lib/insights/feature-flags.ts` | `insightsMode(env)`, `insightsEnabledFor(env, learner)` (off / internal = `isAdmin` / pilot = admin or email in `INSIGHTS_PILOT_EMAILS` / on = any member), `githubIssuesMode(env)` (returns `off` when `GITHUB_ISSUES_TOKEN` is missing, whatever the var says), numeric var parsers with defaults |
| `src/lib/insights/pipeline-job.ts` | `runInsightsPipeline(env, budget)`: returns `{skipped:'flag_off'}` when the mode is off; otherwise runs `runRetentionStage` → `runAnalyzerStage` → `runProposalStage` in order, each in try/catch and each skipped once `budget.exhausted()` |
| `src/lib/insights/retention-stage.ts` | Stub `runRetentionStage(env, budget) → {stub:true}` (phase 1 owns it from here on) |
| `src/lib/insights/analyzer-stage.ts` | Stub (phase 3 owns it) |
| `src/lib/insights/proposal-stage.ts` | Stub (phase 5 owns it) |
| `skills/ai-unlocked/scripts/lib/redact.mjs` | `redactText(text) → {text, count, kinds}` and `redactValue(obj)`, pure, no imports. Rules: PEM blocks; `sk-…`/`sk-ant-…`/`sk-or-…`; `ghp_`/`gho_`/`github_pat_`; `AKIA…` + aws secret pattern; `xox[bap]-`; Google `AIza…`; JWT `eyJ…\.…\.…`; `Authorization: Bearer …`; `password|passwd|secret|token|api[_-]?key\s*[:=]\s*…`; URL query params named token/key/secret/sig; generic high-entropy runs ≥ 32 chars (base64/hex); emails; VN phone (`(\+84|0)(3|5|7|8|9)\d{8}`); CCCD/CMND (9 or 12 digits next to the words CCCD/CMND/căn cước or standalone 12-digit); card numbers (13–19 digits passing Luhn); IBAN-like; IPv4; home paths `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` → `~`. Replacement `[REDACTED:<kind>]`. |
| `skills/ai-unlocked/scripts/lib/redact.d.mts` | Type declarations so strict TS (`astro check`) can import the `.mjs` |
| `docs/insights-ingest-contract.md` | Wire contract for the endpoints, payload v1, error reasons, pairing flow, hook behaviour (copy from "API contract" below) |
| `tests/unit/insights-redaction.test.ts` | Corpus test (positive and negative cases, Vietnamese text left intact, idempotent on already-redacted text) |
| `tests/unit/insights-migration-schema.test.ts` | Tables, unique keys, CHECKs, and cascade from `insight_reports` to `insight_signal_evidence` |
| `tests/unit/insights-feature-flags.test.ts` | Mode matrix; GitHub mode forced `off` without a token |

## Files to modify

| File | Change |
|---|---|
| `src/env.d.ts` | Add optional vars `INSIGHTS_MODE`, `INSIGHTS_PILOT_EMAILS`, `INSIGHTS_RETENTION_DAYS`, `INSIGHTS_DAILY_ANALYSES_PER_LEARNER`, `INSIGHTS_DAILY_ANALYSES_GLOBAL`, `INSIGHTS_GITHUB_ISSUES`, `INSIGHTS_GITHUB_REPO`; secret `GITHUB_ISSUES_TOKEN?` |
| `wrangler.jsonc` | `vars`: `"INSIGHTS_MODE": "off"`, `"INSIGHTS_GITHUB_ISSUES": "off"`, `"INSIGHTS_GITHUB_REPO": "mrgoonie/unlock-zuey-me"`, retention and caps with comments; add `GITHUB_ISSUES_TOKEN` to the secrets comment |
| `src/lib/jobs/scheduled-jobs.ts` | Append `{ name: 'insights-pipeline', run: (budget) => runInsightsPipeline(env, budget) }` last in `scheduledJobs` (`:54-95`) |
| `src/lib/privacy/learner-data-tables.ts` | Add before `ai_usage` (children before `learners`): `insight_access_audit`, `insight_events` (omit `payload_json` from export? **no**, export it, since it is the learner's own redacted data), `insight_reports`, `insight_tokens` (`omitFromExport: ['token_hash']`), `insight_consents` |
| `tests/unit/observer-seed-fixtures.ts` | Seed one row per new learner table (consents, token, event, report, audit) |
| `tests/unit/jobs-scheduled-dispatch.test.ts` | Line 13 asserts the exact job list `['push-reminders','oauth-purge','guest-cleanup','evidence-gc']`, so append `'insights-pipeline'`. Phase 0 owns this one edit. |

## Data model (`0008_insights.sql`)

```sql
-- Three opt-in consents for the ai-tutor insights feature. Absent row = all 0. Separate from observer_consent.
CREATE TABLE insight_consents (
  learner_id TEXT PRIMARY KEY REFERENCES learners(id),
  analysis INTEGER NOT NULL DEFAULT 0 CHECK (analysis IN (0, 1)),
  share_operator INTEGER NOT NULL DEFAULT 0 CHECK (share_operator IN (0, 1)),
  proposals INTEGER NOT NULL DEFAULT 0 CHECK (proposals IN (0, 1)),
  analysis_at TEXT, share_operator_at TEXT, proposals_at TEXT,
  updated_at TEXT NOT NULL
);

-- Device ingestion tokens (hash only), scope insights:write, revocable per device.
CREATE TABLE insight_tokens (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  adapter TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'insights:write' CHECK (scope = 'insights:write'),
  created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX idx_insight_tokens_learner ON insight_tokens(learner_id);

-- Durable queue of redacted turns. payload_json is NULLed once processed or dead.
CREATE TABLE insight_events (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  token_id TEXT,
  idempotency_key TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  source_runtime TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  payload_json TEXT,
  payload_bytes INTEGER NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'skipped', 'dead')),
  skip_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_id TEXT,               -- random claim token of the worker currently processing the row
  lease_until TEXT,
  last_error TEXT,
  report_id TEXT,
  turn_ended_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (learner_id, idempotency_key)
);
CREATE INDEX idx_insight_events_queue ON insight_events(status, next_attempt_at);
CREATE INDEX idx_insight_events_learner ON insight_events(learner_id, received_at);
CREATE INDEX idx_insight_events_session ON insight_events(learner_id, session_ref, status);

-- ai-tutor reports (observable-only, validated JSON). TTL via expires_at.
CREATE TABLE insight_reports (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  session_ref TEXT NOT NULL,
  mission_id TEXT, run_id TEXT,
  report_json TEXT NOT NULL,
  intent_summary TEXT NOT NULL,
  skills_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  has_product_observation INTEGER NOT NULL DEFAULT 0,
  source_runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  useful INTEGER CHECK (useful IS NULL OR useful IN (0, 1)),
  window_started_at TEXT NOT NULL, window_ended_at TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX idx_insight_reports_learner ON insight_reports(learner_id, created_at);
CREATE INDEX idx_insight_reports_expiry ON insight_reports(expires_at);

-- De-identified product signals (no learner column). Evidence rows hang off reports and cascade with them.
CREATE TABLE insight_signals (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('bug', 'content', 'ux', 'feature')),
  area TEXT NOT NULL,
  title TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE insight_signal_evidence (
  signal_id TEXT NOT NULL REFERENCES insight_signals(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES insight_reports(id) ON DELETE CASCADE,
  abstract_evidence TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (signal_id, report_id)
);
CREATE INDEX idx_signal_evidence_report ON insight_signal_evidence(report_id);

CREATE TABLE insight_proposals (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE REFERENCES insight_signals(id),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'duplicate', 'accepted', 'rejected', 'filing', 'issue_filed', 'shipped', 'monitored')),
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  gate_json TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  duplicate_of TEXT,
  ai_handle INTEGER NOT NULL DEFAULT 0,
  ai_handle_approved_by TEXT,
  github_issue_number INTEGER, github_issue_url TEXT,
  filing_lease_until TEXT,
  shipped_ref TEXT, shipped_at TEXT,
  decided_by TEXT, decided_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_insight_proposals_status ON insight_proposals(status, updated_at);

-- Every operator view of one learner's insight detail. learner_id = the observed learner (exported/erased with them).
CREATE TABLE insight_access_audit (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_insight_audit_learner ON insight_access_audit(learner_id, created_at);

-- Operator runtime toggles (e.g. safe_auto_implement). Effective only when the env flags allow.
CREATE TABLE insight_operator_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

The lifetime check covers all new tables. They are process-global D1 rows scoped by `learner_id`. No field is added to `LearnerContext` or any per-request structure, and consents are read by SQL joins, never cached.

## API contract (`docs/insights-ingest-contract.md`, abridged)

`POST /api/ingest/v1/turns` with `Authorization: Bearer aiu_ing_<43 base64url chars>` and a JSON body (≤ 32 KB):

```json
{
  "v": 1, "adapter": "claude-code", "adapterVersion": "0.1.0",
  "idempotencyKey": "<sha256 hex of session_id + ':' + (prompt_id || sha256(last_assistant_message))>",
  "sessionRef": "<sha256 hex of session_id + install salt>",
  "sentAt": "ISO", "turnEndedAt": "ISO",
  "turn": {
    "userPrompt": "string|null (≤ 4000)",
    "assistantFinal": "string (≤ 6000)",
    "tools": [{ "name": "Bash|Edit|mcp__ai-unlocked__start_mission|…", "ok": true, "count": 1 }],
    "platform": { "mcpTools": ["start_mission"], "missionId": "plan-weekend", "runId": "run_…" }
  },
  "redaction": { "count": 2, "kinds": ["email", "api_key"] },
  "truncated": false,
  "stopHookActive": false
}
```

Responses:
- `202 {accepted:true, duplicate:boolean}`.
- `401 unauthorized` when the token is unknown, revoked, or expired.
- `403 forbidden` with `reason`:
  - `consent_required`: analysis consent is off.
  - `origin_forbidden`: a browser Origin header is present.
- `404 not_found` when the feature is off for this learner.
- `400 invalid` for the schema, size, or the `sentAt` window (±10 min).
- `429 rate_limited` or `budget_exceeded` (daily ingest cap of 200 per learner).

Other endpoints (phase 1):
- `GET /api/ingest/v1/status` (bearer) → `{feature:true, consents:{analysis}, token:{label, expiresAt}, serverVersion, latestSkillVersion}`.
- `DELETE /api/ingest/v1/token` (bearer, revoke self).
- `POST /api/ingest/v1/pair/start` `{label, adapter}` → `{deviceCode, userCode, verificationUri, interval:5, expiresIn:600}`.
- `POST /api/ingest/v1/pair/poll` `{deviceCode}` → `428 {status:'pending'}` | `200 {token, expiresAt}` (returned exactly once) | `410 {status:'expired'|'denied'}`.

## Steps

1. Write the migration and run `bun run db:migrate:local`. Add the schema test using `createTestD1()`.
2. Write `redact.mjs`, its `.d.mts`, and the corpus test. Import it from the test via a relative path, as the Worker will.
3. Add `ingest-contract.ts` (zod), `insight-types.ts`, and `feature-flags.ts` with their tests.
4. Add `pipeline-job.ts` and the three stage stubs, then append the job in `scheduled-jobs.ts`.
5. Register the tables in `learner-data-tables.ts` and extend the seed fixtures. Run `bun run test` until the privacy registry and export tests pass.
6. Add the env, wrangler, and doc entries. Run `bun run build`, where `astro check` must accept the `.mjs` import.

## Tests

`insights-redaction.test.ts`, `insights-migration-schema.test.ts`, `insights-feature-flags.test.ts`. Existing `privacy-data-rights.test.ts`, `jobs-scheduled-dispatch.test.ts`, and `jobs-cleanup.test.ts` must stay green.

## Success criteria

- `bun run test` and `bun run build` are green.
- With `INSIGHTS_MODE` unset, the pipeline job returns `{skipped:'flag_off'}`, costs 0 subrequests, and charges nothing.
- The privacy registry test lists all five new learner tables.

## Risks

| Risk | L × I | Mitigation |
|---|---|---|
| A redaction regex causes ReDoS on 30 KB text | M × M | Bounded quantifiers only, input capped before the regex runs, and a test that runs 32 KB of adversarial input in under 50 ms |
| `astro check` rejects the `.mjs` import, or type-checks `redact.mjs` itself (it checks every JS file; `playwright.config.ts:14-16`) | M × L | JSDoc-typed, check-clean `redact.mjs` plus a `.d.mts` sibling. Fallback: exclude `skills/ai-unlocked/scripts` in `tsconfig.json` (phase 0 owns `tsconfig.json`). Last resort: duplicate the rules in TS and add a test that both modules give identical output on the corpus. |
| The seed fixture change breaks unrelated tests that count rows | L × M | Run the full suite. Fixtures only add rows in new tables. |

## Rollback

Revert the phase 0 PR. The migration cannot be undone on D1, but the empty tables are harmless. Leave them and drop them in a later migration only if the feature is abandoned.
