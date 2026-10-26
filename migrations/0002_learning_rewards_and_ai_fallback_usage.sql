-- Learning engine additions (never edit 0001).
-- What a submission earned ({xpGained, newBadges}), so an idempotent replay returns the original rewards
-- without granting anything again.
ALTER TABLE evaluations ADD COLUMN rewards_json TEXT;
-- Workers AI fallback calls are capped per learner per day separately from the OpenRouter USD budget.
ALTER TABLE ai_usage ADD COLUMN workers_ai_requests INTEGER NOT NULL DEFAULT 0;
-- Fast lookups for progress/recap queries.
CREATE INDEX idx_runs_learner_status ON mission_runs(learner_id, status);
CREATE INDEX idx_xp_learner ON xp_ledger(learner_id, created_at);
