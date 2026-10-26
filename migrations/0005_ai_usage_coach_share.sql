-- Grading is protected from coaching traffic (additive only; never edit earlier migrations).
-- Practice chat and hints together may use at most a configurable share (AI_DAILY_COACH_SHARE, default 0.5)
-- of the global daily OpenRouter USD budget and Workers AI request cap; grading may use the full caps.
-- These columns hold the coaching part of each ai_usage row so the reservation UPDATE can check it
-- atomically next to the totals (cost_usd / reserved_usd / workers_ai_requests still include it).
ALTER TABLE ai_usage ADD COLUMN coach_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN coach_reserved_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN coach_workers_ai_requests INTEGER NOT NULL DEFAULT 0;
