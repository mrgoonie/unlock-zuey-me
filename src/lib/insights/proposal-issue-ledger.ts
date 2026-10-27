/**
 * D1 ledger of GitHub issues per signal fingerprint (`insight_issue_filings`, migration 0010). It makes one
 * fingerprint impossible to file twice, whatever GitHub's search index says:
 *
 * - A create first CLAIMS the fingerprint (primary key; a compare-and-set on the row it read), so two
 *   attempts can never both reach the POST.
 * - A claim left in `creating` after an ambiguous create stays until a later attempt resolves it from the
 *   repository issue list (`listByFingerprintSince`, not search-indexed): the issue is linked when it exists,
 *   and the claim is dropped only when the complete listing proves it does not.
 * - A `filed` row is re-checked by issue number (a direct read, never search).
 *
 * The table holds no learner column.
 */
import { GithubIssueError, type GithubIssuePublisher, type GithubIssueRef } from './github-issue-publisher';

export interface IssueFilingRow {
  fingerprint: string;
  proposal_id: string;
  status: 'creating' | 'filed';
  issue_number: number | null;
  issue_url: string | null;
  claimed_at: string;
  updated_at: string;
}

/** Clock-skew margin between this worker and GitHub when listing issues created after a claim. */
export const CLAIM_LIST_MARGIN_MS = 5 * 60_000;

export async function getIssueFiling(db: D1Database, fingerprint: string): Promise<IssueFilingRow | null> {
  return db.prepare(`SELECT * FROM insight_issue_filings WHERE fingerprint = ?`).bind(fingerprint).first<IssueFilingRow>();
}

/**
 * Claims the fingerprint for a create. `seen` is the row read before deciding (null when there was none):
 * the claim succeeds only if the row is still exactly that, so a concurrent claim or record wins and this
 * attempt must not create. Returns the claim's timestamp, or null when the claim was lost.
 */
export async function claimIssueFiling(
  db: D1Database, fingerprint: string, proposalId: string, seen: IssueFilingRow | null, now: Date,
): Promise<string | null> {
  const at = now.toISOString();
  const r = seen
    ? await db.prepare(`UPDATE insight_issue_filings SET proposal_id = ?, status = 'creating', issue_number = NULL, issue_url = NULL,
        claimed_at = ?, updated_at = ? WHERE fingerprint = ? AND status = ? AND claimed_at = ? AND updated_at = ?`)
      .bind(proposalId, at, at, fingerprint, seen.status, seen.claimed_at, seen.updated_at).run()
    : await db.prepare(`INSERT INTO insight_issue_filings (fingerprint, proposal_id, status, claimed_at, updated_at)
        VALUES (?, ?, 'creating', ?, ?) ON CONFLICT(fingerprint) DO NOTHING`)
      .bind(fingerprint, proposalId, at, at).run();
  return (r.meta.changes ?? 0) === 1 ? at : null;
}

/**
 * Records the issue a fingerprint is filed as (after a create, or when an existing issue is linked). Writes
 * nothing unless the proposal still holds `guard.lease`, and, after a create, unless the row is still this
 * attempt's own claim (`guard.claimedAt`): an attempt that lost either never overwrites the winner's record.
 */
export function recordIssueFilingStatement(
  db: D1Database, fingerprint: string, proposalId: string, issue: { number: number; url: string }, now: Date,
  guard: { lease: string; claimedAt: string | null },
): D1PreparedStatement {
  const at = now.toISOString();
  return db.prepare(`INSERT INTO insight_issue_filings (fingerprint, proposal_id, status, issue_number, issue_url, claimed_at, updated_at)
      SELECT ?, ?, 'filed', ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM insight_proposals WHERE id = ? AND status = 'filing' AND filing_lease_until = ?)
      ON CONFLICT(fingerprint) DO UPDATE SET proposal_id = excluded.proposal_id, status = 'filed', issue_number = excluded.issue_number,
        issue_url = excluded.issue_url, updated_at = excluded.updated_at
      WHERE ? IS NULL OR (insight_issue_filings.status = 'creating' AND insight_issue_filings.claimed_at = ?)`)
    .bind(fingerprint, proposalId, issue.number, issue.url, at, at, proposalId, guard.lease, guard.claimedAt, guard.claimedAt);
}

/** Drops a `creating` claim once it is proven that its create made no issue (only the claim it names). */
export async function dropIssueClaim(db: D1Database, fingerprint: string, claimedAt: string): Promise<void> {
  await db.prepare(`DELETE FROM insight_issue_filings WHERE fingerprint = ? AND status = 'creating' AND claimed_at = ?`)
    .bind(fingerprint, claimedAt).run();
}

export interface KnownIssues {
  /** The ledger's issue: the recorded one, or the one an unresolved create turned out to have made. */
  ledgerIssue: GithubIssueRef | null;
  /** The ledger's issue plus every issue the marker search finds (manual issues too), without duplicates. */
  all: GithubIssueRef[];
}

/**
 * Every issue known for a fingerprint. Throws (GithubIssueError) whenever the answer could be incomplete,
 * so a caller never treats "unknown" as "absent". A recorded issue that GitHub no longer has (deleted or
 * transferred: 404/410) is reported as none, which lets the next claim take the row over.
 */
export async function knownIssues(publisher: GithubIssuePublisher, fingerprint: string, ledger: IssueFilingRow | null): Promise<KnownIssues> {
  let ledgerIssue: GithubIssueRef | null = null;
  if (ledger?.status === 'filed' && ledger.issue_number !== null) {
    try {
      ledgerIssue = await publisher.getIssueState(ledger.issue_number);
    } catch (err) {
      if (!(err instanceof GithubIssueError && (err.status === 404 || err.status === 410))) throw err;
    }
  } else if (ledger?.status === 'creating') {
    const since = new Date(Date.parse(ledger.claimed_at) - CLAIM_LIST_MARGIN_MS).toISOString();
    const listed = await publisher.listByFingerprintSince(fingerprint, since);
    ledgerIssue = listed.sort((a, b) => a.number - b.number)[0] ?? null; // the first one created after the claim
  }
  const searched = await publisher.searchByFingerprint(fingerprint);
  const all = ledgerIssue ? [ledgerIssue, ...searched.filter((i) => i.number !== ledgerIssue.number)] : searched;
  return { ledgerIssue, all };
}
