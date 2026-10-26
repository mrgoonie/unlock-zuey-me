-- ai-tutor insights (#25). Additive only: new tables and indexes, nothing on existing tables, so the previous
-- worker keeps working when this is applied before the new worker goes live. Every table stays empty and
-- unreferenced while INSIGHTS_MODE=off. Learner-owned tables are registered in
-- src/lib/privacy/learner-data-tables.ts so export and delete cover them.

-- Three opt-in consents for the ai-tutor insights feature. Absent row = all 0. Separate from observer_consent.
CREATE TABLE insight_consents (
  learner_id TEXT PRIMARY KEY REFERENCES learners(id),
  analysis INTEGER NOT NULL DEFAULT 0 CHECK (analysis IN (0, 1)),
  share_operator INTEGER NOT NULL DEFAULT 0 CHECK (share_operator IN (0, 1)),
  proposals INTEGER NOT NULL DEFAULT 0 CHECK (proposals IN (0, 1)),
  analysis_at TEXT,
  share_operator_at TEXT,
  proposals_at TEXT,
  updated_at TEXT NOT NULL
);

-- Device ingestion tokens (SHA-256 hash only), scope insights:write, revocable per device.
CREATE TABLE insight_tokens (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  adapter TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'insights:write' CHECK (scope = 'insights:write'),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_insight_tokens_learner ON insight_tokens(learner_id);

-- Durable queue of redacted turns. payload_json is NULLed once processed, skipped or dead.
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
  -- Random claim token of the worker currently processing the row.
  lease_id TEXT,
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

-- ai-tutor reports (observable-only, validated JSON). TTL via expires_at (INSIGHTS_RETENTION_DAYS).
CREATE TABLE insight_reports (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  session_ref TEXT NOT NULL,
  mission_id TEXT,
  run_id TEXT,
  report_json TEXT NOT NULL,
  intent_summary TEXT NOT NULL,
  skills_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  has_product_observation INTEGER NOT NULL DEFAULT 0 CHECK (has_product_observation IN (0, 1)),
  source_runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  useful INTEGER CHECK (useful IS NULL OR useful IN (0, 1)),
  window_started_at TEXT NOT NULL,
  window_ended_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_insight_reports_learner ON insight_reports(learner_id, created_at);
CREATE INDEX idx_insight_reports_expiry ON insight_reports(expires_at);

-- De-identified product signals (no learner column). Evidence rows hang off reports and cascade with them,
-- so deleting a learner's reports removes their contribution to every signal.
CREATE TABLE insight_signals (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('bug', 'content', 'ux', 'feature')),
  area TEXT NOT NULL,
  title TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE insight_signal_evidence (
  signal_id TEXT NOT NULL REFERENCES insight_signals(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES insight_reports(id) ON DELETE CASCADE,
  abstract_evidence TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (signal_id, report_id)
);
CREATE INDEX idx_signal_evidence_report ON insight_signal_evidence(report_id);

-- Proposals derived from signals; one per signal. GitHub filing is gated (INSIGHTS_GITHUB_ISSUES + token).
CREATE TABLE insight_proposals (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE REFERENCES insight_signals(id),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'duplicate', 'accepted', 'rejected', 'filing', 'issue_filed', 'shipped', 'monitored')),
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  gate_json TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  duplicate_of TEXT,
  ai_handle INTEGER NOT NULL DEFAULT 0 CHECK (ai_handle IN (0, 1)),
  ai_handle_approved_by TEXT,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  filing_lease_until TEXT,
  shipped_ref TEXT,
  shipped_at TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_insight_proposals_status ON insight_proposals(status, updated_at);

-- Every operator view of one learner's insight detail. learner_id = the observed learner (exported and
-- erased with them). No FK so the audit trail never blocks a learner delete ordering.
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
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
