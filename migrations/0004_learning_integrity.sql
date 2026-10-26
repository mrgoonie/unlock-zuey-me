-- Learning integrity (additive; never edit earlier migrations).

-- Quiz/prediction answers revealed on the server: ["stepId:itemId", ...]. A revealed answer is locked.
ALTER TABLE mission_runs ADD COLUMN revealed_json TEXT NOT NULL DEFAULT '[]';

-- At most one open run per (learner, mission). Existing duplicates are cleaned first: every open run except
-- the most recently updated one (ties broken by id) is abandoned.
UPDATE mission_runs
   SET status = 'abandoned', rev = rev + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status NOT IN ('completed', 'abandoned')
   AND EXISTS (
     SELECT 1 FROM mission_runs o
      WHERE o.learner_id = mission_runs.learner_id AND o.mission_id = mission_runs.mission_id AND o.id <> mission_runs.id
        AND o.status NOT IN ('completed', 'abandoned')
        AND (o.updated_at > mission_runs.updated_at OR (o.updated_at = mission_runs.updated_at AND o.id > mission_runs.id)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_open_per_mission
  ON mission_runs(learner_id, mission_id) WHERE status NOT IN ('completed', 'abandoned');

-- Mission XP is paid once per (learner, mission): the ledger ref becomes the mission id instead of the run
-- id. The first pass per mission is re-keyed; XP already paid for repeat passes stays recorded under its
-- run id, and any later pass of that mission now collides with the mission-keyed row and pays nothing.
UPDATE OR IGNORE xp_ledger
   SET ref = (SELECT r.mission_id FROM mission_runs r WHERE r.id = xp_ledger.ref)
 WHERE reason = 'mission_pass'
   AND EXISTS (SELECT 1 FROM mission_runs r WHERE r.id = xp_ledger.ref);
