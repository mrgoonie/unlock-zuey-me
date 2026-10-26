-- Abuse and cost caps (additive only; never edit earlier migrations).
-- USD reserved by in-flight OpenRouter calls. A call reserves its worst-case cost with one conditional
-- UPDATE before it starts and settles the real cost afterwards, so concurrent calls cannot all pass the
-- daily budget check at once.
ALTER TABLE ai_usage ADD COLUMN reserved_usd REAL NOT NULL DEFAULT 0;
-- Inactive-guest cleanup scans guests by age.
CREATE INDEX idx_learners_kind_created ON learners(kind, created_at);
-- Lab result cap per learner, lab and day.
CREATE INDEX idx_lab_runs_learner_lab_created ON lab_runs(learner_id, lab_id, created_at);
