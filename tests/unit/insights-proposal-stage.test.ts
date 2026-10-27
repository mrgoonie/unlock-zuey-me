/**
 * Proposal stage end to end on the real schema: linking, fingerprint dedupe, cohort and consent gating, and
 * proposals without any GitHub credential (zero network). GitHub filing: insights-proposal-github-filing.test.ts.
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

  it('only established learners count: fresh accounts or accounts without a completed mission never make a cohort', async () => {
    const db = await freshDb([]);
    await addLearner(db, 'lrn_a');
    await addLearner(db, 'lrn_b');
    await addLearner(db, 'lrn_new', { createdAt: daysAgo(3) }); // completed a mission, but the account is 3 days old
    await addLearner(db, 'lrn_idle', { missionCompletedAt: null }); // old account, never completed a mission
    await addLearner(db, 'lrn_late', { missionCompletedAt: minutesAgo(5) }); // first mission completed after the report
    await seedCohort(db, ['lrn_a', 'lrn_b']);
    for (const l of ['lrn_new', 'lrn_idle', 'lrn_late']) await addReport(db, l, observation({ summary: 'Sybil wording muốn vào issue.' }));
    const { model, prompts } = stubModel();
    const r = await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: model });
    expect(r).toMatchObject({ linked: 5, proposalsCreated: 0 });
    expect(prompts).toHaveLength(0);
    const signal = String(await db.prepare(`SELECT id FROM insight_signals`).first('id'));
    expect(await cohortStats(db, signal, '')).toMatchObject({ learners: 2, occurrences: 2 });

    // A third established learner completes the cohort; the sybil-like accounts still add nothing.
    await addLearner(db, 'lrn_c');
    await addReport(db, 'lrn_c', observation(), { createdAt: minutesAgo(5, later(3_600_000)) });
    const r2 = await runProposalStage(baseEnv(db), budget(), later(3_600_000), { draftModel: model });
    expect(r2.proposalsCreated).toBe(1);
    expect(await cohortStats(db, signal, '')).toMatchObject({ learners: 3, occurrences: 3 });
    // Their wording never reaches the model either.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Gợi ý bước 2 khó hiểu');
    expect(prompts[0]).not.toContain('Sybil wording');
  });

  it('an account counts only for reports written once it was 7 days old, even after it becomes established', async () => {
    const db = await freshDb([]);
    for (const id of ['lrn_a', 'lrn_b']) await addLearner(db, id);
    // Account created 10 days ago, first mission 9 days ago; one report on day 2, one on day 8.
    await addLearner(db, 'lrn_c', { createdAt: daysAgo(10), missionCompletedAt: daysAgo(9) });
    await seedCohort(db, ['lrn_a', 'lrn_b']);
    const early = await addReport(db, 'lrn_c', observation(), { createdAt: daysAgo(8) });
    await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
    const signal = String(await db.prepare(`SELECT id FROM insight_signals`).first('id'));
    expect((await cohortStats(db, signal, '')).learners).toBe(2);
    expect(await count(db, `SELECT COUNT(*) AS n FROM insight_signal_evidence WHERE report_id = '${early}'`)).toBe(1); // linked, not counted
    await addReport(db, 'lrn_c', observation(), { createdAt: minutesAgo(5, later(3_600_000)) });
    await runProposalStage(baseEnv(db), budget(), later(3_600_000), { draftModel: stubModel().model });
    expect((await cohortStats(db, signal, '')).learners).toBe(3);
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
