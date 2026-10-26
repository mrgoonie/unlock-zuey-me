-- Hint unlocks per (run, step, level) (additive; never edit earlier migrations).
-- The row is reserved before the coach is called (that reservation is what charges hints_used), and the
-- generated text is stored on it, so a retry of an already-unlocked level returns the stored text without
-- a new AI call or a second charge. `text` is NULL while the first request is still generating.
-- Rows belong to the run: deleting a run (privacy erase, guest cleanup) deletes its hints.
CREATE TABLE run_hints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
  text TEXT,
  origin TEXT CHECK (origin IS NULL OR origin IN ('ai', 'static')),
  model TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, step_id, level)
);
