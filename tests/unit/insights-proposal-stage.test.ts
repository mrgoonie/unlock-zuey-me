/**
 * Proposal stage end to end on the real schema: linking, fingerprint dedupe, cohort and consent gating,
 * proposals without any GitHub credential (zero network), and with a mocked GitHub: marker search, link,
 * 30-day cooldown, lease against concurrent filing, daily cap, ai-handle, and post-ship monitoring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { githubIssuesMode } from '../../src/lib/insights/feature-flags';
import { setSafeAutoImplement } from '../../src/lib/insights/operator-settings';
import { fileProposal, parseObservation, runProposalStage } from '../../src/lib/insights/proposal-stage';
import { cohortStats } from '../../src/lib/insights/proposal-store';
import {
  addLearner, addReport, baseEnv, daysAgo, fakeGithub, freshDb, githubEnv, minutesAgo, NOW, observation, seedCohort, stubModel,
} from './insights-proposal-stage-fixtures';

const count = async (db: D1Database, sql: string) => Number(await db.prepare(sql).first('n'));
const proposals = (db: D1Database) =>
  db.prepare(`SELECT * FROM insight_proposals ORDER BY created_at, id`).all<Record<string, unknown>>().then((r) => r.results);
const budget = () => createCronBudget();
const later = (ms: number) => new Date(NOW.getTime() + ms);

afterEach(() => vi.restoreAllMocks());

describe('proposal stage without GitHub', () => {
  it('merges paraphrased topic keys into one signal and creates one dashboard proposal, with zero network', async () => {
    const db = await freshDb();
    await seedCohort(db);
    const gh = fakeGithub();
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const { model } = stubModel();
    const r = await runProposalStage(baseEnv(db), budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: model });
    expect(r).toMatchObject({ linked: 3, proposalsCreated: 1, githubMode: 'off', filed: 0 });
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_signals`)).toBe(1);
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_signal_evidence`)).toBe(3);
    const [p] = await proposals(db);
    expect(p.status).toBe('proposed');
    expect(JSON.parse(String(p.gate_json))).toEqual({ decision: 'proposal', risk: 'low', reasons: ['github_off', 'no_token'] });
    expect(JSON.parse(String(p.draft_json))).toMatchObject({ source: 'ai', model: 'stub-model' });
    expect(gh.calls).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('never makes a GitHub call without the token, even with INSIGHTS_GITHUB_ISSUES=issues_ai_handle', async () => {
    const db = await freshDb();
    await seedCohort(db);
    const env = baseEnv(db, { INSIGHTS_GITHUB_ISSUES: 'issues_ai_handle' });
    expect(githubIssuesMode(env)).toBe('off');
    const gh = fakeGithub();
    await setSafeAutoImplement(db, true, 'lrn_admin', NOW);
    const r = await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r.proposalsCreated).toBe(1);
    expect(gh.calls).toHaveLength(0);
    const [p] = await proposals(db);
    expect(await fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl })).toEqual({ kind: 'github_off' });
    expect(gh.calls).toHaveLength(0);
  });

  it('keeps one proposal per fingerprint across ticks and only refreshes its gate', async () => {
    const db = await freshDb();
    await seedCohort(db);
    const { model, prompts } = stubModel();
    await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: model });
    await addReport(db, 'lrn_d', observation({ topic_key: 'STEP hint, unclear!' }), { createdAt: minutesAgo(5, later(3_600_000)) });
    const r2 = await runProposalStage(baseEnv(db), budget(), later(3_600_000), { draftModel: model });
    expect(r2).toMatchObject({ linked: 1, proposalsCreated: 0, evaluated: 1 });
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_proposals`)).toBe(1);
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_signals`)).toBe(1);
    expect(prompts).toHaveLength(1); // the existing proposal is re-gated without another model call
  });

  it('is idempotent: re-running a tick links nothing twice', async () => {
    const db = await freshDb();
    await seedCohort(db);
    await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
    const again = await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
    expect(again).toMatchObject({ linked: 0, ignored: 0, evaluated: 0, proposalsCreated: 0 });
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_signal_evidence`)).toBe(3);
  });

  it('never creates a signal from personal preferences, missing or malformed observations', async () => {
    const db = await freshDb();
    for (const l of ['lrn_a', 'lrn_b', 'lrn_c']) {
      await addReport(db, l, observation({ category: 'personal_preference' }));
      await addReport(db, l, null);
    }
    await db.prepare(`UPDATE insight_reports SET has_product_observation = 1`).run(); // even if a flag is wrong
    const r = await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
    expect(r).toMatchObject({ linked: 0, proposalsCreated: 0 });
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_signals`)).toBe(0);
    expect(parseObservation('{"product_observation":{"category":"bug","area":"labs","topic_key":"x","summary":"y","confidence":"high"}}')).toBeNull();
    expect(parseObservation('not json')).toBeNull();
  });

  it('a single learner repeating an observation 10 times is a cohort of 1: no proposal, no model call', async () => {
    const db = await freshDb();
    for (let i = 0; i < 10; i++) await addReport(db, 'lrn_a', observation());
    const { model, prompts } = stubModel();
    const r = await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: model });
    expect(r).toMatchObject({ linked: 10, proposalsCreated: 0 });
    expect(prompts).toHaveLength(0);
  });

  it('every category needs 3 consenting learners: 2 never make a proposal or a model call', async () => {
    const db = await freshDb();
    for (const category of ['bug', 'content', 'ux', 'feature'] as const) {
      await seedCohort(db, ['lrn_a', 'lrn_b'], { category, area: category === 'ux' ? 'onboarding' : 'labs', topic_key: `${category} lab score wrong` });
    }
    const { model, prompts } = stubModel();
    await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: model });
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_proposals`)).toBe(0);
    expect(prompts).toHaveLength(0);
    await seedCohort(db, ['lrn_c'], { category: 'bug', area: 'labs', topic_key: 'bug lab score wrong' });
    await runProposalStage(baseEnv(db), budget(), later(120_000), { draftModel: model });
    const rows = await db.prepare(`SELECT s.category FROM insight_proposals p JOIN insight_signals s ON s.id = p.signal_id`).all<{ category: string }>();
    expect(rows.results.map((x) => x.category)).toEqual(['bug']);
  });

  it('links only reports written after proposals consent and drops revoked learners from the cohort', async () => {
    const db = await freshDb([]);
    await addLearner(db, 'lrn_a');
    await addLearner(db, 'lrn_b');
    await addLearner(db, 'lrn_c', { proposalsAt: minutesAgo(10) }); // consented after the report below
    await addLearner(db, 'lrn_d', { proposals: false });
    await seedCohort(db, ['lrn_a', 'lrn_b', 'lrn_c']);
    await addReport(db, 'lrn_d', observation());
    const r = await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
    expect(r).toMatchObject({ linked: 2, ignored: 2 });
    const signal = String(await db.prepare(`SELECT id FROM insight_signals`).first('id'));
    expect((await cohortStats(db, signal, daysAgo(14))).learners).toBe(2);
    await db.prepare(`UPDATE insight_consents SET proposals = 0, proposals_at = NULL WHERE learner_id = 'lrn_b'`).run();
    expect((await cohortStats(db, signal, daysAgo(14))).learners).toBe(1);
    // A learner delete cascades their evidence through the report FK.
    await db.prepare(`DELETE FROM insight_reports WHERE learner_id = 'lrn_a'`).run();
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_signal_evidence`)).toBe(1);
  });

  it('falls back to the deterministic template when the model fails', async () => {
    const db = await freshDb();
    await seedCohort(db);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel(new Error('down')).model });
    const [p] = await proposals(db);
    expect(JSON.parse(String(p.draft_json))).toMatchObject({ source: 'template', model: null });
  });

  it('defers without failing when the budget is spent, and resumes on the next tick', async () => {
    const db = await freshDb();
    await seedCohort(db);
    const tiny = createCronBudget({ d1Queries: 4, subrequests: 100 });
    const r = await runProposalStage(baseEnv(db), tiny, NOW, { draftModel: stubModel().model });
    expect(r.deferred).toBe(true);
    const r2 = await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
    expect(r.linked + r2.linked).toBe(3);
    expect(r2.proposalsCreated).toBe(1);
  });
});

describe('proposal stage with a mocked GitHub', () => {
  async function filedSetup(mode: 'issues' | 'issues_ai_handle' = 'issues_ai_handle', safeAuto = true) {
    const db = await freshDb();
    if (safeAuto) await setSafeAutoImplement(db, true, 'lrn_admin', NOW);
    await seedCohort(db);
    return { db, env: githubEnv(db, mode) };
  }

  it('files a gate-passing low-risk content proposal with ai-handle, searching for the marker first', async () => {
    const { db, env } = await filedSetup();
    const gh = fakeGithub();
    const r = await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r).toMatchObject({ proposalsCreated: 1, filed: 1 });
    expect(gh.calls.slice(0, 2).map((c) => `${c.method} ${new URL(c.url).pathname}`))
      .toEqual(['GET /search/issues', 'POST /repos/mrgoonie/unlock-zuey-me/issues']);
    expect(gh.issues[0].labels).toEqual(['ai-insights', 'insight:content', 'ai-handle']);
    expect(gh.issues[0].body).toMatch(/<!-- ai-unlocked-fp:[0-9a-f]{64} -->/);
    const [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'issue_filed', github_issue_number: 100, ai_handle: 1 });
  });

  it('files without ai-handle in mode issues, and without it when safe_auto_implement is off', async () => {
    for (const [mode, safe] of [['issues', true], ['issues_ai_handle', false]] as const) {
      const { env } = await filedSetup(mode, safe);
      const gh = fakeGithub();
      await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
      expect(gh.issues).toHaveLength(1);
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

  it('links an open issue that already carries the marker instead of creating one', async () => {
    const { db, env } = await filedSetup();
    const gh = fakeGithub();
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    // Simulate a crash after the create: the proposal lost its issue number but GitHub has the issue.
    await db.prepare(`UPDATE insight_proposals SET status = 'accepted', github_issue_number = NULL, github_issue_url = NULL`).run();
    const [p] = await proposals(db);
    const out = await fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl });
    expect(out).toMatchObject({ kind: 'linked', number: 100 });
    expect(gh.posts()).toHaveLength(1);
  });

  it('marks a duplicate when the marker issue closed within 30 days, and files again after the cooldown', async () => {
    for (const [closedDaysAgo, expected] of [[10, 'duplicate'], [40, 'filed']] as const) {
      const { db, env } = await filedSetup('issues');
      const gh = fakeGithub();
      await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
      Object.assign(gh.issues[0], { state: 'closed', closed_at: daysAgo(closedDaysAgo), state_reason: 'completed' });
      await db.prepare(`UPDATE insight_proposals SET status = 'accepted', github_issue_number = NULL, github_issue_url = NULL`).run();
      const [p] = await proposals(db);
      const out = await fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl });
      expect(out.kind).toBe(expected);
      expect(gh.posts()).toHaveLength(expected === 'filed' ? 2 : 1);
    }
  });

  it('two concurrent filings of the same proposal make exactly one POST', async () => {
    const { db, env } = await filedSetup('issues');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runProposalStage(env, budget(), NOW, { draftModel: stubModel().model, fetchImpl: fakeGithub({ searchStatus: 503 }).fetchImpl });
    const [p] = await proposals(db);
    expect(p.status).toBe('proposed'); // search failed: lease released, nothing filed
    const gh = fakeGithub({ delayMs: 5 });
    const outs = await Promise.all([1, 2].map(() => fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl })));
    expect(outs.map((o) => o.kind).sort()).toEqual(['busy', 'filed']);
    expect(gh.posts()).toHaveLength(1);
  });

  it('respects the daily cap of 3 issues', async () => {
    const db = await freshDb();
    const topics = ['quiz answer typo', 'concept example outdated', 'lab score wrong', 'hint missing link'];
    for (const t of topics) await seedCohort(db, ['lrn_a', 'lrn_b', 'lrn_c'], { topic_key: t, area: 'concepts' });
    const env = githubEnv(db, 'issues');
    const gh = fakeGithub();
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    await runProposalStage(env, budget(), later(60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(gh.posts()).toHaveLength(3);
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_proposals WHERE status = 'issue_filed'`)).toBe(3);
    const fourth = (await proposals(db)).find((p) => p.status !== 'issue_filed');
    expect(JSON.parse(String(fourth?.gate_json)).reasons).toContain('daily_cap');
    // The next UTC day has a fresh budget.
    await runProposalStage(env, budget(), later(86_400_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(gh.posts()).toHaveLength(4);
  });

  it('a 422 on create releases the lease and the daily slot, and logs no token', async () => {
    const { db, env } = await filedSetup('issues');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gh = fakeGithub({ createStatus: 422 });
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    const [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'proposed', filing_lease_until: null, github_issue_number: null });
    expect(await count(db, `SELECT COALESCE(SUM(CAST(value AS INTEGER)), 0) AS n FROM insight_operator_settings WHERE key LIKE 'issues_filed:%'`)).toBe(0);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(env.GITHUB_ISSUES_TOKEN);
  });

  it('moves a closed issue to shipped, a not-planned one to rejected, and shipped to monitored after 14 days', async () => {
    const { db, env } = await filedSetup('issues');
    const gh = fakeGithub();
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
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
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    Object.assign(gh.issues[0], { state: 'closed', closed_at: NOW.toISOString(), state_reason: 'not_planned' });
    await runProposalStage(env, budget(), later(60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect((await proposals(db))[0].status).toBe('rejected');
  });
});
