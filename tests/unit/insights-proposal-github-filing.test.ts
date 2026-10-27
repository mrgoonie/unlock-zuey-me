/**
 * GitHub filing of proposals against a mocked GitHub (no real network): only an operator's explicit click
 * creates an issue (the cron never does), marker search and the D1 fingerprint ledger link existing issues,
 * the 30-day cooldown, the lease against concurrent filing, the daily cap, ai-handle labels, and post-ship
 * monitoring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { setSafeAutoImplement } from '../../src/lib/insights/operator-settings';
import { fileProposal, runProposalStage } from '../../src/lib/insights/proposal-stage';
import { applyTriage } from '../../src/lib/insights/proposal-store';
import {
  addReport, daysAgo, fakeGithub, freshDb, githubEnv, minutesAgo, NOW, observation, seedCohort, stubModel,
} from './insights-proposal-stage-fixtures';

const count = async (db: D1Database, sql: string) => Number(await db.prepare(sql).first('n'));
const proposals = (db: D1Database) =>
  db.prepare(`SELECT * FROM insight_proposals ORDER BY created_at, id`).all<Record<string, unknown>>().then((r) => r.results);
const budget = () => createCronBudget();
const later = (ms: number) => new Date(NOW.getTime() + ms);

afterEach(() => vi.restoreAllMocks());

async function filedSetup(mode: 'issues' | 'issues_ai_handle' = 'issues_ai_handle', safeAuto = true) {
  const db = await freshDb();
  if (safeAuto) await setSafeAutoImplement(db, true, 'lrn_admin', NOW);
  await seedCohort(db);
  return { db, env: githubEnv(db, mode) };
}

/** One cron tick (creates the proposal, files nothing), then the operator's "Tạo issue GitHub" click. */
async function operatorFiles(db: D1Database, env: Env, gh: ReturnType<typeof fakeGithub>, at = NOW) {
  const r = await runProposalStage(env, budget(), at, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
  expect(r.filed).toBe(0);
  const [p] = await proposals(db);
  return fileProposal(env, String(p.id), at, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl });
}

describe('GitHub filing needs an operator', () => {
  it('the cron never creates an issue, even at the ai-handle tier or for an accepted proposal', async () => {
    const { db, env } = await filedSetup();
    const gh = fakeGithub();
    const r = await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r).toMatchObject({ proposalsCreated: 1, filed: 0 });
    let [p] = await proposals(db);
    expect(JSON.parse(String(p.gate_json))).toMatchObject({ decision: 'issue_ai_handle' });
    expect(await applyTriage(db, String(p.id), 'accept', { actor: 'lrn_admin', now: NOW })).toBe(true);
    await runProposalStage(env, budget(), later(15 * 60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(gh.posts()).toHaveLength(0);
    // Without the operator flag the filing path refuses before taking the lease.
    expect(await fileProposal(env, String(p.id), later(16 * 60_000), { operator: false, actor: 'system:insights', fetchImpl: gh.fetchImpl }))
      .toEqual({ kind: 'operator_required' });
    [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'accepted', filing_lease_until: null });
    expect(gh.calls).toHaveLength(0);
  });

  it('an operator click files a gate-passing low-risk content proposal with ai-handle, searching for the marker first', async () => {
    const { db, env } = await filedSetup();
    const gh = fakeGithub();
    expect(await operatorFiles(db, env, gh)).toMatchObject({ kind: 'filed', number: 100, aiHandle: true });
    expect(gh.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))
      .toEqual(['GET /search/issues', 'POST /repos/mrgoonie/unlock-zuey-me/issues']);
    expect(gh.issues[0].labels).toEqual(['ai-insights', 'insight:content', 'ai-handle']);
    expect(gh.issues[0].body).toMatch(/<!-- ai-unlocked-fp:[0-9a-f]{64} -->/);
    const [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'issue_filed', github_issue_number: 100, ai_handle: 1, decided_by: 'lrn_admin' });
    expect(await db.prepare(`SELECT status, issue_number, proposal_id FROM insight_issue_filings`).first())
      .toEqual({ status: 'filed', issue_number: 100, proposal_id: p.id });
  });

  it('files without ai-handle in mode issues, and without it when safe_auto_implement is off', async () => {
    for (const [mode, safe] of [['issues', true], ['issues_ai_handle', false]] as const) {
      const { db, env } = await filedSetup(mode, safe);
      const gh = fakeGithub();
      expect(await operatorFiles(db, env, gh)).toMatchObject({ kind: 'filed', aiHandle: false });
      expect(gh.issues[0].labels).not.toContain('ai-handle');
    }
  });

  it('keeps medium-risk proposals in the dashboard even when the model hints low', async () => {
    const db = await freshDb();
    await setSafeAutoImplement(db, true, 'lrn_admin', NOW);
    await seedCohort(db, ['lrn_a', 'lrn_b', 'lrn_c'], { category: 'bug', area: 'settings' });
    const gh = fakeGithub();
    await runProposalStage(githubEnv(db, 'issues_ai_handle'), budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel(undefined).model });
    expect(gh.posts()).toHaveLength(0);
    const [p] = await proposals(db);
    expect(p.status).toBe('proposed');
    expect(JSON.parse(String(p.gate_json))).toMatchObject({ decision: 'proposal', risk: 'medium', reasons: ['risk_not_low'] });
  });

  it('respects the daily cap of 3 issues', async () => {
    const db = await freshDb();
    const topics = ['quiz answer typo', 'concept example outdated', 'lab score wrong', 'hint missing link'];
    for (const t of topics) await seedCohort(db, ['lrn_a', 'lrn_b', 'lrn_c'], { topic_key: t, area: 'concepts' });
    const env = githubEnv(db, 'issues');
    const gh = fakeGithub();
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    const ids = (await proposals(db)).map((p) => String(p.id));
    const file = (id: string, at: Date) => fileProposal(env, id, at, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl });
    const outs: string[] = [];
    for (const id of ids) outs.push((await file(id, later(60_000))).kind);
    expect(outs).toEqual(['filed', 'filed', 'filed', 'daily_cap']);
    expect(gh.posts()).toHaveLength(3);
    const fourth = (await proposals(db)).find((p) => p.status !== 'issue_filed');
    expect(fourth).toMatchObject({ status: 'proposed', filing_lease_until: null });
    // The next UTC day has a fresh budget.
    expect((await file(String(fourth?.id), later(86_400_000))).kind).toBe('filed');
    expect(gh.posts()).toHaveLength(4);
  });
});

describe('one fingerprint is never filed twice', () => {
  it('links the recorded issue (by number, not search) instead of creating another one', async () => {
    const { db, env } = await filedSetup();
    const gh = fakeGithub({ searchLag: true });
    await operatorFiles(db, env, gh);
    // The proposal lost its issue number (manual edit), but the fingerprint ledger still has it.
    await db.prepare(`UPDATE insight_proposals SET status = 'accepted', github_issue_number = NULL, github_issue_url = NULL`).run();
    const [p] = await proposals(db);
    expect(await fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl }))
      .toMatchObject({ kind: 'linked', number: 100 });
    expect(gh.posts()).toHaveLength(1);
  });

  it('links an open issue that only the marker search knows (filed by hand from the copied markdown)', async () => {
    const { db, env } = await filedSetup();
    const gh = fakeGithub();
    await operatorFiles(db, env, gh);
    await db.prepare(`UPDATE insight_proposals SET status = 'accepted', github_issue_number = NULL, github_issue_url = NULL`).run();
    await db.prepare(`DELETE FROM insight_issue_filings`).run();
    const [p] = await proposals(db);
    expect(await fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl }))
      .toMatchObject({ kind: 'linked', number: 100 });
    expect(gh.posts()).toHaveLength(1);
  });

  it('marks a duplicate when the issue closed within 30 days, and files again (taking the ledger row over) after the cooldown', async () => {
    for (const [closedDaysAgo, expected] of [[10, 'duplicate'], [40, 'filed']] as const) {
      const { db, env } = await filedSetup('issues');
      const gh = fakeGithub();
      await operatorFiles(db, env, gh);
      Object.assign(gh.issues[0], { state: 'closed', closed_at: daysAgo(closedDaysAgo), state_reason: 'completed' });
      await db.prepare(`UPDATE insight_proposals SET status = 'accepted', github_issue_number = NULL, github_issue_url = NULL`).run();
      const [p] = await proposals(db);
      const out = await fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl });
      expect(out.kind).toBe(expected);
      expect(gh.posts()).toHaveLength(expected === 'filed' ? 2 : 1);
      expect(await db.prepare(`SELECT status, issue_number FROM insight_issue_filings`).first())
        .toEqual({ status: 'filed', issue_number: expected === 'filed' ? 101 : 100 });
    }
  });

  it('after an ambiguous create, search lag cannot cause a second issue: the issue list finds it', async () => {
    const { db, env } = await filedSetup('issues');
    const gh = fakeGithub({ createStatusAfterCreate: 502, searchLag: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await operatorFiles(db, env, gh)).toEqual({ kind: 'github_error', status: 502 });
    let [p] = await proposals(db);
    expect(p.status).toBe('filing'); // ambiguous: lease, claim and slot kept
    expect(await db.prepare(`SELECT status FROM insight_issue_filings`).first('status')).toBe('creating');

    // The operator retries while the lease holds: busy, nothing posted.
    expect(await fileProposal(env, String(p.id), later(30_000), { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl }))
      .toEqual({ kind: 'busy' });
    // The cron recovers the expired lease from the issue list (search still sees nothing) and links it.
    const r = await runProposalStage(env, budget(), later(3 * 60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r).toMatchObject({ linkedIssues: 1, filed: 0 });
    [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'issue_filed', github_issue_number: 100, filing_lease_until: null });
    expect(gh.posts()).toHaveLength(1);
    const list = gh.calls.find((c) => c.method === 'GET' && new URL(c.url).pathname === '/repos/mrgoonie/unlock-zuey-me/issues');
    expect(new URL(String(list?.url)).searchParams.get('labels')).toBe('ai-insights');
  });

  it('a D1 failure while recording a created issue keeps the claim, so the issue is linked later, never filed again', async () => {
    const { db, env } = await filedSetup('issues');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gh = fakeGithub({ searchLag: true });
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    const [p] = await proposals(db);
    const flaky = { ...db, batch: async () => { throw new Error('d1 unavailable'); } } as unknown as D1Database;
    expect(await fileProposal({ ...env, DB: flaky }, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl }))
      .toEqual({ kind: 'github_error', status: 500 });
    expect(gh.posts()).toHaveLength(1);
    expect(await db.prepare(`SELECT status FROM insight_issue_filings`).first('status')).toBe('creating');
    await runProposalStage(env, budget(), later(3 * 60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect((await proposals(db))[0]).toMatchObject({ status: 'issue_filed', github_issue_number: 100 });
    expect(gh.posts()).toHaveLength(1);
  });

  it('an unresolvable claim (issue list failing) blocks every create', async () => {
    const { db, env } = await filedSetup('issues');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await operatorFiles(db, env, fakeGithub({ createStatusAfterCreate: 502 }));
    // GitHub lost the issue from search and the list endpoint fails: no proof either way.
    const gh = fakeGithub({ searchLag: true });
    const failingList = async (input: string, init: RequestInit) =>
      init.method === 'GET' && new URL(input).pathname.endsWith('/issues') ? new Response('{}', { status: 503 }) : gh.fetchImpl(input, init);
    const [p] = await proposals(db);
    const out = await fileProposal(env, String(p.id), later(3 * 60_000), { operator: false, actor: 'system:insights', fetchImpl: failingList });
    expect(out).toEqual({ kind: 'github_error', status: 503 });
    const op = await fileProposal(env, String(p.id), later(4 * 60_000), { operator: true, actor: 'lrn_admin', fetchImpl: failingList });
    expect(op).toEqual({ kind: 'github_error', status: 503 });
    expect(gh.posts()).toHaveLength(0);
    expect(await db.prepare(`SELECT status FROM insight_issue_filings`).first('status')).toBe('creating');
  });

  it('when the issue list proves no issue exists, the expired lease is released and only an operator files again, once', async () => {
    const { db, env } = await filedSetup('issues');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await operatorFiles(db, env, fakeGithub({ createStatus: 503 }))).toEqual({ kind: 'github_error', status: 503 });
    let [p] = await proposals(db);
    expect(p.status).toBe('filing');
    const gh = fakeGithub();
    const r = await runProposalStage(env, budget(), later(3 * 60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r).toMatchObject({ filingsReleased: 1, filed: 0 });
    [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'proposed', filing_lease_until: null }); // never accepted by an operator
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_issue_filings`)).toBe(0);
    expect(await fileProposal(env, String(p.id), later(4 * 60_000), { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl }))
      .toMatchObject({ kind: 'filed' });
    expect(gh.posts()).toHaveLength(1);
  });

  it('a failed marker search releases the lease, and two concurrent filings of the same proposal make exactly one POST', async () => {
    const { db, env } = await filedSetup('issues');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await operatorFiles(db, env, fakeGithub({ searchStatus: 503 }))).toEqual({ kind: 'github_error', status: 503 });
    const [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'proposed', filing_lease_until: null });
    const gh = fakeGithub({ delayMs: 5 });
    const outs = await Promise.all([1, 2].map(() => fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl })));
    expect(outs.map((o) => o.kind).sort()).toEqual(['busy', 'filed']);
    expect(gh.posts()).toHaveLength(1);
  });

  it('recovery after a failed record keeps the ai-handle label the created issue carries', async () => {
    const { db, env } = await filedSetup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gh = fakeGithub({ searchLag: true });
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    const [p] = await proposals(db);
    const flaky = { ...db, batch: async () => { throw new Error('d1 unavailable'); } } as unknown as D1Database;
    await fileProposal({ ...env, DB: flaky }, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl });
    expect(gh.issues[0].labels).toContain('ai-handle');
    await runProposalStage(env, budget(), later(3 * 60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect((await proposals(db))[0]).toMatchObject({ status: 'issue_filed', github_issue_number: 100, ai_handle: 1 });
  });

  it('an attempt too slow to finish its create inside the lease creates nothing and gives everything back', async () => {
    const { db, env } = await filedSetup('issues');
    const gh = fakeGithub();
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    const [p] = await proposals(db);
    const t0 = Date.now();
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + (calls++ === 0 ? 0 : 100_000)); // the first read starts the clock
    expect(await fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl })).toEqual({ kind: 'busy' });
    expect(gh.posts()).toHaveLength(0);
    expect((await proposals(db))[0]).toMatchObject({ status: 'proposed', filing_lease_until: null });
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_issue_filings`)).toBe(0);
    expect(await count(db, `SELECT COALESCE(SUM(CAST(value AS INTEGER)), 0) AS n FROM insight_operator_settings WHERE key LIKE 'issues_filed:%'`)).toBe(0);
  });

  it('a 422 on create releases the lease, the daily slot and the fingerprint claim, and logs no token', async () => {
    const { db, env } = await filedSetup('issues');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await operatorFiles(db, env, fakeGithub({ createStatus: 422 }))).toEqual({ kind: 'github_error', status: 422 });
    const [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'proposed', filing_lease_until: null, github_issue_number: null });
    expect(await count(db, `SELECT COALESCE(SUM(CAST(value AS INTEGER)), 0) AS n FROM insight_operator_settings WHERE key LIKE 'issues_filed:%'`)).toBe(0);
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_issue_filings`)).toBe(0);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(env.GITHUB_ISSUES_TOKEN);
  });
});

describe('post-ship monitoring', () => {
  it('moves a closed issue to shipped, a not-planned one to rejected, and shipped to monitored after 14 days', async () => {
    const { db, env } = await filedSetup('issues');
    const gh = fakeGithub();
    await operatorFiles(db, env, gh);
    Object.assign(gh.issues[0], { state: 'closed', closed_at: NOW.toISOString(), state_reason: 'completed' });
    const r = await runProposalStage(env, budget(), later(60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r.shipped).toBe(1);
    expect((await proposals(db))[0]).toMatchObject({ status: 'shipped', shipped_ref: gh.issues[0].html_url });
    // More evidence on a shipped signal only accumulates: no new proposal, no new issue.
    await addReport(db, 'lrn_d', observation(), { createdAt: minutesAgo(5, later(86_400_000)) });
    const r2 = await runProposalStage(env, budget(), later(86_400_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r2).toMatchObject({ linked: 1, proposalsCreated: 0, filed: 0 });
    const r3 = await runProposalStage(env, budget(), later(15 * 86_400_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r3.monitored).toBe(1);
    expect((await proposals(db))[0].status).toBe('monitored');
    expect(gh.posts()).toHaveLength(1);
  });

  it('maps an issue closed as not planned to rejected', async () => {
    const { db, env } = await filedSetup('issues');
    const gh = fakeGithub();
    await operatorFiles(db, env, gh);
    Object.assign(gh.issues[0], { state: 'closed', closed_at: NOW.toISOString(), state_reason: 'not_planned' });
    await runProposalStage(env, budget(), later(60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect((await proposals(db))[0].status).toBe('rejected');
  });
});
