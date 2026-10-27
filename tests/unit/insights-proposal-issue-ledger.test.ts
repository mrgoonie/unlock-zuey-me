/**
 * D1 fingerprint ledger (`insight_issue_filings`): one claim per fingerprint, compare-and-set takeover,
 * dropping only the claim it names, and resolving known issues without trusting search alone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMigrationSql } from '../../scripts/migration-safety-rules';
import { createGithubIssuePublisher } from '../../src/lib/insights/github-issue-publisher';
import {
  claimIssueFiling, dropIssueClaim, getIssueFiling, knownIssues, recordIssueFilingStatement,
} from '../../src/lib/insights/proposal-issue-ledger';
import { createTestD1 } from '../helpers/d1-sqlite';
import { FAKE_TOKEN, fakeGithub, NOW } from './insights-proposal-stage-fixtures';

const FP = 'c'.repeat(64);
const later = (ms: number) => new Date(NOW.getTime() + ms);
const LEASE = later(120_000).toISOString();

/** A proposal in `filing` holding LEASE, which recordIssueFilingStatement requires before it writes. */
async function holding(db: D1Database, id = 'prp_a', lease = LEASE) {
  const at = NOW.toISOString();
  await db.prepare(`INSERT OR IGNORE INTO insight_signals (id, fingerprint, category, area, title, first_seen_at, last_seen_at, created_at)
    VALUES ('sig_l', ?, 'content', 'concepts', 't', ?, ?, ?)`).bind(FP, at, at, at).run();
  await db.prepare(`INSERT INTO insight_proposals (id, signal_id, status, risk, gate_json, draft_json, filing_lease_until, created_at, updated_at)
    VALUES (?, 'sig_l', 'filing', 'low', '{}', '{}', ?, ?, ?)`).bind(id, lease, at, at).run();
  return { lease, claimedAt: null as string | null };
}

describe('0010_insight_issue_filings migration', () => {
  const file = '0010_insight_issue_filings.sql';
  const sql = readFileSync(join(__dirname, '..', '..', 'migrations', file), 'utf8');

  it('passes the additive-only migration guard and holds no learner column', async () => {
    expect(checkMigrationSql(file, sql)).toEqual([]);
    const cols = await createTestD1().prepare(`SELECT name FROM pragma_table_info('insight_issue_filings')`).all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual(['fingerprint', 'proposal_id', 'status', 'issue_number', 'issue_url', 'claimed_at', 'updated_at']);
  });

  it('backfills filed issues and in-flight filings from the existing proposals', async () => {
    const db = createTestD1();
    await db.prepare(`DROP TABLE insight_issue_filings`).run();
    const at = NOW.toISOString();
    for (const [n, status, issue] of [[1, 'issue_filed', 41], [2, 'filing', null], [3, 'proposed', null]] as const) {
      await db.prepare(`INSERT INTO insight_signals (id, fingerprint, category, area, title, first_seen_at, last_seen_at, created_at)
        VALUES (?, ?, 'content', 'concepts', 't', ?, ?, ?)`).bind(`sig_${n}`, String(n).repeat(64), at, at, at).run();
      await db.prepare(`INSERT INTO insight_proposals (id, signal_id, status, risk, gate_json, draft_json, github_issue_number, github_issue_url,
        created_at, updated_at) VALUES (?, ?, ?, 'low', '{}', '{}', ?, ?, ?, ?)`)
        .bind(`prp_${n}`, `sig_${n}`, status, issue, issue ? `https://github.com/o/r/issues/${issue}` : null, at, at).run();
    }
    await db.exec(sql);
    const rows = await db.prepare(`SELECT proposal_id, status, issue_number FROM insight_issue_filings ORDER BY proposal_id`).all();
    expect(rows.results).toEqual([
      { proposal_id: 'prp_1', status: 'filed', issue_number: 41 },
      { proposal_id: 'prp_2', status: 'creating', issue_number: null },
    ]);
  });
});

describe('issue filing ledger', () => {
  it('lets exactly one of two concurrent first claims win', async () => {
    const db = createTestD1();
    const claims = await Promise.all([claimIssueFiling(db, FP, 'prp_a', null, NOW), claimIssueFiling(db, FP, 'prp_b', null, NOW)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await getIssueFiling(db, FP)).toMatchObject({ status: 'creating', proposal_id: 'prp_a', claimed_at: NOW.toISOString() });
  });

  it('takes a row over only if it is still exactly the row that was read', async () => {
    const db = createTestD1();
    const hold = await holding(db);
    await claimIssueFiling(db, FP, 'prp_a', null, NOW);
    const seen = await getIssueFiling(db, FP);
    await db.batch([recordIssueFilingStatement(db, FP, 'prp_a', { number: 7, url: 'https://github.com/o/r/issues/7' }, later(1_000), hold)]);
    expect(await claimIssueFiling(db, FP, 'prp_a', seen, later(2_000))).toBeNull(); // the row changed meanwhile
    const filed = await getIssueFiling(db, FP);
    expect(filed).toMatchObject({ status: 'filed', issue_number: 7 });
    expect(await claimIssueFiling(db, FP, 'prp_a', filed, later(3_000))).toBe(later(3_000).toISOString());
    expect(await getIssueFiling(db, FP)).toMatchObject({ status: 'creating', issue_number: null });
  });

  it('drops only the claim it names, never a recorded issue', async () => {
    const db = createTestD1();
    const hold = await holding(db);
    await claimIssueFiling(db, FP, 'prp_a', null, NOW);
    await dropIssueClaim(db, FP, later(1).toISOString());
    expect(await getIssueFiling(db, FP)).not.toBeNull();
    await db.batch([recordIssueFilingStatement(db, FP, 'prp_a', { number: 7, url: 'u' }, NOW, hold)]);
    await dropIssueClaim(db, FP, NOW.toISOString());
    expect(await getIssueFiling(db, FP)).toMatchObject({ status: 'filed' });
  });

  it('writes nothing for an attempt that lost its lease or its claim to a later one', async () => {
    const db = createTestD1();
    await holding(db, 'prp_c', later(300_000).toISOString()); // the attempt that took the row over holds a newer lease
    const staleClaim = (await claimIssueFiling(db, FP, 'prp_a', null, NOW)) as string;
    const winnerClaim = (await claimIssueFiling(db, FP, 'prp_c', await getIssueFiling(db, FP), later(200_000))) as string;
    // Stale lease: no write at all, even with no claim guard.
    await db.batch([recordIssueFilingStatement(db, FP, 'prp_c', { number: 8, url: 'u8' }, later(210_000), { lease: LEASE, claimedAt: null })]);
    expect(await getIssueFiling(db, FP)).toMatchObject({ status: 'creating', claimed_at: winnerClaim });
    // Current lease but someone else's claim: the winner's claim stays.
    await db.batch([recordIssueFilingStatement(db, FP, 'prp_c', { number: 8, url: 'u8' }, later(210_000),
      { lease: later(300_000).toISOString(), claimedAt: staleClaim })]);
    expect(await getIssueFiling(db, FP)).toMatchObject({ status: 'creating', claimed_at: winnerClaim });
    // The holder of both records its issue.
    await db.batch([recordIssueFilingStatement(db, FP, 'prp_c', { number: 9, url: 'u9' }, later(220_000),
      { lease: later(300_000).toISOString(), claimedAt: winnerClaim })]);
    expect(await getIssueFiling(db, FP)).toMatchObject({ status: 'filed', issue_number: 9, proposal_id: 'prp_c' });
  });

  it('resolves a recorded issue by number, treats a deleted one (404) as gone, and an unresolved create from the issue list', async () => {
    const gh = fakeGithub({ searchLag: true });
    const pub = createGithubIssuePublisher({ GITHUB_ISSUES_TOKEN: FAKE_TOKEN } as Env, gh.fetchImpl);
    if (!pub) throw new Error('publisher');
    const made = await pub.createIssue({ title: 'T', body: `<!-- ai-unlocked-fp:${FP} -->`, category: 'bug', aiHandle: false });
    const row = {
      fingerprint: FP, proposal_id: 'prp_a', status: 'filed' as const, issue_number: made.number, issue_url: made.url,
      claimed_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    };
    expect((await knownIssues(pub, FP, row)).all.map((i) => i.number)).toEqual([100]);
    expect(await knownIssues(pub, FP, { ...row, issue_number: 999 })).toEqual({ ledgerIssue: null, all: [] });
    // Search lags (sees nothing), but the issue list does.
    const creating = { ...row, status: 'creating' as const, issue_number: null, issue_url: null };
    expect((await knownIssues(pub, FP, creating)).ledgerIssue).toMatchObject({ number: 100 });
    expect(await knownIssues(pub, FP, null)).toEqual({ ledgerIssue: null, all: [] });
  });
});
