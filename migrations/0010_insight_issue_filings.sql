-- One GitHub issue per signal fingerprint, enforced in D1 instead of relying on GitHub search.
--
-- The proposal filing path claims the fingerprint here (primary key) before it creates an issue, and records
-- the issue number once GitHub answers. A claim left in 'creating' (an ambiguous create: network error or
-- 5xx after the POST) blocks every further create for that fingerprint until a later attempt proves, from
-- GitHub's issue list (not the lagging search index), whether the issue exists. No learner column: the
-- fingerprint is a hash of category, area and topic, and the issue itself is public.
CREATE TABLE insight_issue_filings (
  fingerprint TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating', 'filed')),
  issue_number INTEGER,
  issue_url TEXT,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Backfill: issues already filed, and filings that may have reached GitHub (still leased as 'filing').
INSERT OR IGNORE INTO insight_issue_filings (fingerprint, proposal_id, status, issue_number, issue_url, claimed_at, updated_at)
  SELECT s.fingerprint, p.id, 'filed', p.github_issue_number, p.github_issue_url, p.updated_at, p.updated_at
  FROM insight_proposals p JOIN insight_signals s ON s.id = p.signal_id
  WHERE p.github_issue_number IS NOT NULL;
INSERT OR IGNORE INTO insight_issue_filings (fingerprint, proposal_id, status, issue_number, issue_url, claimed_at, updated_at)
  SELECT s.fingerprint, p.id, 'creating', NULL, NULL, p.updated_at, p.updated_at
  FROM insight_proposals p JOIN insight_signals s ON s.id = p.signal_id
  WHERE p.status = 'filing' AND p.github_issue_number IS NULL;
