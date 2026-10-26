-- AI Unlocked initial schema. One D1 database is the single source of truth for web and /mcp.
-- Ids are opaque text with a short prefix (lrn_, ses_, run_, sub_, evl_ ...). Timestamps are ISO-8601 UTC.

-- A learner starts as a guest (device cookie) and becomes a member after "Sign in with zuey.me".
CREATE TABLE learners (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('guest', 'member')),
  zuey_sub TEXT UNIQUE,                 -- userinfo `sub` from zuey.me; NULL for guests
  email TEXT,                           -- verified email from zuey.me (members only)
  display_name TEXT,
  avatar_url TEXT,
  -- Onboarding answers and preferences: {goal, familiarity, obstacle, sound, reduced_motion, language_style, timezone}
  profile_json TEXT NOT NULL DEFAULT '{}',
  -- Learner consent to share their journey (events, scores, evidence) with observers (admins).
  observer_consent INTEGER NOT NULL DEFAULT 0,
  observer_consent_at TEXT,
  merged_into TEXT,                     -- guest row that was merged into a member row
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_learners_email ON learners(email);

-- Browser sessions. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_learner ON sessions(learner_id);

-- Pending "Sign in with zuey.me" requests (PKCE verifier + state), single use, 10 minutes.
CREATE TABLE login_requests (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  learner_id TEXT,                      -- guest that started the login (merged on success)
  return_to TEXT NOT NULL DEFAULT '/home',
  -- When the login serves the /mcp OAuth consent, the serialized authorization request.
  oauth_request_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Per-competency proficiency projected from evaluations (0..1 score, evidence count).
CREATE TABLE competency_scores (
  learner_id TEXT NOT NULL REFERENCES learners(id),
  competency TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, competency)
);

-- One attempt at one mission version. State machine in src/lib/learning/mission-state-machine.ts.
CREATE TABLE mission_runs (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  mission_id TEXT NOT NULL,
  mission_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'paused', 'awaiting_evidence', 'evaluating', 'needs_revision', 'evaluation_failed', 'completed', 'abandoned')),
  current_step TEXT,
  answers_json TEXT NOT NULL DEFAULT '{}',   -- {stepId: {fieldId: value}} autosaved draft answers
  confidence INTEGER,                        -- learner's predicted score 0..100 before evaluation (calibration)
  hint_max_level INTEGER NOT NULL DEFAULT 0,
  hints_used INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'mcp')),
  rev INTEGER NOT NULL DEFAULT 0,            -- optimistic concurrency counter
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_runs_learner ON mission_runs(learner_id, updated_at);
CREATE INDEX idx_runs_mission ON mission_runs(mission_id);

-- Evidence the learner deliberately submits. Idempotent per (run, idempotency_key).
CREATE TABLE evidence_submissions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES mission_runs(id),
  learner_id TEXT NOT NULL REFERENCES learners(id),
  idempotency_key TEXT NOT NULL,
  answers_json TEXT NOT NULL,                -- frozen copy of answers at submission time
  image_keys_json TEXT NOT NULL DEFAULT '[]',-- R2 keys in EVIDENCE bucket
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL,
  UNIQUE (run_id, idempotency_key)
);
CREATE INDEX idx_submissions_learner ON evidence_submissions(learner_id, created_at);

-- Evaluation history (never overwritten); the latest per submission is current.
CREATE TABLE evaluations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES mission_runs(id),
  submission_id TEXT NOT NULL REFERENCES evidence_submissions(id),
  learner_id TEXT NOT NULL REFERENCES learners(id),
  status TEXT NOT NULL CHECK (status IN ('passed', 'needs_revision', 'failed')),
  score REAL NOT NULL,
  criteria_json TEXT NOT NULL,               -- [{id, label, weight, score, method, feedback}]
  feedback TEXT NOT NULL,
  strengths_json TEXT NOT NULL DEFAULT '[]',
  improvements_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL CHECK (mode IN ('deterministic', 'mixed')),
  grader_model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_evaluations_run ON evaluations(run_id, created_at);

-- Append-only XP ledger; (learner, reason, ref) is unique so a retry never pays twice.
CREATE TABLE xp_ledger (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (learner_id, reason, ref)
);

CREATE TABLE badge_grants (
  learner_id TEXT NOT NULL REFERENCES learners(id),
  badge_id TEXT NOT NULL,
  ref TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, badge_id)
);

-- Days with meaningful learning activity (learner local date) for the soft streak.
CREATE TABLE activity_days (
  learner_id TEXT NOT NULL REFERENCES learners(id),
  day TEXT NOT NULL,                         -- YYYY-MM-DD in the learner's timezone
  PRIMARY KEY (learner_id, day)
);

CREATE TABLE lab_runs (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  lab_id TEXT NOT NULL,
  result_json TEXT NOT NULL,                 -- {correct, total, calibration...} — simulation results only
  created_at TEXT NOT NULL
);
CREATE INDEX idx_lab_runs_learner ON lab_runs(learner_id, lab_id);

-- Concept pages the learner opened ("exposure"), for recap and decoder progress.
CREATE TABLE concept_views (
  learner_id TEXT NOT NULL REFERENCES learners(id),
  concept_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (learner_id, concept_id)
);

-- Coach and practice-chat messages (learner-owned; visible to observers only with consent).
CREATE TABLE coach_messages (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  run_id TEXT,
  step_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('hint', 'practice')),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  hint_level INTEGER,
  model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_coach_learner ON coach_messages(learner_id, created_at);

-- AI spend per learner per UTC day (estimated from token usage) for budget caps.
CREATE TABLE ai_usage (
  day TEXT NOT NULL,
  learner_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, learner_id)
);

-- Typed learning events (no raw evidence text). Powers the observer timeline and KPIs.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  mission_id TEXT,
  mission_version INTEGER,
  run_id TEXT,
  props_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'web',
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_events_learner ON events(learner_id, occurred_at);
CREATE INDEX idx_events_name ON events(name, occurred_at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  remind_time TEXT NOT NULL DEFAULT '20:00',  -- HH:MM learner local time
  timezone TEXT NOT NULL DEFAULT 'Asia/Saigon',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_day TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_push_learner ON push_subscriptions(learner_id);

-- Certificates are public by code (shareable) and snapshot what was earned.
CREATE TABLE certificates (
  code TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learners(id),
  level TEXT NOT NULL,
  display_name TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (learner_id, level)
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  learner_id TEXT,
  context TEXT,
  rating INTEGER,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
