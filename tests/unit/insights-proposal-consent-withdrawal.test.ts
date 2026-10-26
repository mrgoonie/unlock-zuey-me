/**
 * Proposals follow the CURRENT consented evidence: when learners revoke `proposals` consent, delete their
 * reports or their account, no filing path (cron auto-file, an accepted proposal, the operator's
 * `file_issue`) may publish anything, and the stored draft built from that evidence is withdrawn (or
 * rebuilt from the evidence-free template while the cohort still stands). Also: no proposal stays stuck in
 * `filing`, and stuck rows cannot starve the per-tick filing slots.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { setSafeAutoImplement } from '../../src/lib/insights/operator-settings';
import { fileProposal, proposalDetail, runProposalStage } from '../../src/lib/insights/proposal-stage';
import { applyTriage, FILING_LEASE_MS } from '../../src/lib/insights/proposal-store';
import { GET as detailRoute } from '../../src/pages/api/v1/admin/insights/proposals/[id]';
import { learnerCtx, routeContext } from './observer-seed-fixtures';
import { baseEnv, fakeGithub, freshDb, githubEnv, NOW, seedCohort, stubModel } from './insights-proposal-stage-fixtures';

const budget = () => createCronBudget();
const later = (ms: number) => new Date(NOW.getTime() + ms);
const proposals = (db: D1Database) =>
  db.prepare(`SELECT * FROM insight_proposals ORDER BY created_at, id`).all<Record<string, unknown>>().then((r) => r.results);
const LEARNERS = ['lrn_a', 'lrn_b', 'lrn_c'];

afterEach(() => vi.restoreAllMocks());

/** Three consenting learners → one proposal (GitHub off while it is created), accepted by an operator. */
async function acceptedProposal(learners = LEARNERS) {
  const db = await freshDb(['lrn_a', 'lrn_b', 'lrn_c', 'lrn_d']);
  await setSafeAutoImplement(db, true, 'lrn_admin', NOW);
  await seedCohort(db, learners);
  await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
  const [p] = await proposals(db);
  expect(JSON.parse(String(p.draft_json))).toMatchObject({ source: 'ai' });
  expect(await applyTriage(db, String(p.id), 'accept', { actor: 'lrn_admin', now: NOW })).toBe(true);
  return { db, id: String(p.id) };
}

const WITHDRAWALS: Array<[string, (db: D1Database, learners: string[]) => Promise<void>]> = [
  ['revoke proposals consent', async (db, ls) => {
    for (const l of ls) await db.prepare(`UPDATE insight_consents SET proposals = 0, proposals_at = NULL WHERE learner_id = ?`).bind(l).run();
  }],
  ['delete their reports', async (db, ls) => {
    for (const l of ls) await db.prepare(`DELETE FROM insight_reports WHERE learner_id = ?`).bind(l).run();
  }],
  ['delete their account', async (db, ls) => {
    for (const l of ls) await db.prepare(`UPDATE learners SET deleted_at = ? WHERE id = ?`).bind(NOW.toISOString(), l).run();
  }],
];

describe('every filing path re-checks the consented cohort', () => {
  it.each(WITHDRAWALS)('all contributors %s → neither the cron nor the operator files, and the draft is withdrawn', async (_label, withdraw) => {
    const { db, id } = await acceptedProposal();
    await withdraw(db, LEARNERS);
    const env = githubEnv(db, 'issues_ai_handle');
    const gh = fakeGithub();

    // The operator acts before any cron tick: refused, and the stale draft is erased on the spot.
    const out = await fileProposal(env, id, later(60_000), { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl });
    expect(out).toMatchObject({ kind: 'not_allowed', gate: { decision: 'none', reasons: expect.arrayContaining(['cohort_too_small']) } });
    let [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'proposed', draft_json: '{}', filing_lease_until: null, decided_by: null, github_issue_number: null });

    // The cron never selects it again and makes no GitHub call at all.
    const r = await runProposalStage(env, budget(), later(120_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r.filed).toBe(0);
    expect(gh.calls).toHaveLength(0);
    [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'proposed', draft_json: '{}' });
    expect(JSON.parse(String(p.gate_json))).toMatchObject({ decision: 'none' });

    // Operators no longer see any text built from the withdrawn evidence.
    const detail = await proposalDetail(env, id, later(120_000));
    expect(detail).toMatchObject({ draft: null, issueMarkdown: null });
  });

  it('the cron withdraws the draft of an accepted proposal and never files it, without any operator action', async () => {
    const { db, id } = await acceptedProposal();
    await WITHDRAWALS[0][1](db, LEARNERS);
    const gh = fakeGithub();
    const r = await runProposalStage(githubEnv(db, 'issues'), budget(), later(60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r).toMatchObject({ filed: 0, draftsRefreshed: 1 });
    expect(gh.posts()).toHaveLength(0);
    const [p] = await proposals(db);
    expect(p).toMatchObject({ id, status: 'proposed', draft_json: '{}', decided_by: null });
  });

  it('withdraws the draft of a rejected proposal too, keeping its status', async () => {
    const { db, id } = await acceptedProposal();
    expect(await applyTriage(db, id, 'reject', { actor: 'lrn_admin', now: NOW })).toBe(true);
    await WITHDRAWALS[1][1](db, LEARNERS);
    await runProposalStage(baseEnv(db), budget(), later(60_000), { draftModel: stubModel().model });
    const [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'rejected', draft_json: '{}' });
  });

  it('shows the withdrawn state through the admin detail route', async () => {
    const { db, id } = await acceptedProposal();
    await WITHDRAWALS[2][1](db, LEARNERS);
    const url = `https://unlock.zuey.me/api/v1/admin/insights/proposals/${id}`;
    const res = await detailRoute(routeContext({
      learner: learnerCtx('lrn_admin', { isAdmin: true }), env: { DB: db, INSIGHTS_MODE: 'internal' }, params: { id }, url, request: new Request(url),
    }) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ draft: null, issueMarkdown: null });
    expect(JSON.stringify(body)).not.toContain('step 2 hint');
  });

  it('one contributor leaving a cohort that still stands replaces the model draft with the evidence-free template', async () => {
    const { db, id } = await acceptedProposal(['lrn_a', 'lrn_b', 'lrn_c', 'lrn_d']);
    await WITHDRAWALS[0][1](db, ['lrn_a']);
    const gh = fakeGithub();
    const r = await runProposalStage(githubEnv(db, 'issues'), budget(), later(60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r.draftsRefreshed).toBe(1);
    const [p] = await proposals(db);
    expect(p).toMatchObject({ id, status: 'issue_filed' }); // still 3 consenting learners: the accepted proposal files
    expect(JSON.parse(String(p.draft_json))).toMatchObject({ source: 'template', basis: [] });
    expect(gh.issues[0].body).toContain('## Aggregated evidence (3 learners');
  });

  it('an accepted proposal below the issue confidence is refused once and then no longer takes a filing slot', async () => {
    const db = await freshDb();
    await seedCohort(db, LEARNERS, { confidence: 0.65 });
    await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
    const [p0] = await proposals(db);
    await applyTriage(db, String(p0.id), 'accept', { actor: 'lrn_admin', now: NOW });
    const env = githubEnv(db, 'issues');
    const gh = fakeGithub();
    expect(await fileProposal(env, String(p0.id), later(1_000), { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl }))
      .toMatchObject({ kind: 'not_allowed', gate: { reasons: expect.arrayContaining(['low_confidence']) } });
    const [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'accepted', filing_lease_until: null }); // lease released, acceptance kept
    await runProposalStage(env, budget(), later(60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(gh.calls).toHaveLength(0);
  });
});

describe('no proposal stays stuck in filing', () => {
  /** A create that reaches GitHub but answers 502: the issue exists although the caller saw an error. */
  function lostResponseGithub() {
    const gh = fakeGithub();
    const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
      const res = await gh.fetchImpl(input, init);
      return init.method === 'POST' && /\/issues$/.test(new URL(input).pathname) ? new Response('{}', { status: 502 }) : res;
    };
    return { ...gh, fetchImpl };
  }

  it('after an ambiguous create, the expired lease first finds the issue by its marker and links it', async () => {
    const db = await freshDb();
    await seedCohort(db);
    const env = githubEnv(db, 'issues');
    const gh = lostResponseGithub();
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    let [p] = await proposals(db);
    expect(p.status).toBe('filing'); // ambiguous: lease and slot kept
    await runProposalStage(env, budget(), new Date(NOW.getTime() + FILING_LEASE_MS + 1_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'issue_filed', github_issue_number: 100, filing_lease_until: null });
    expect(gh.posts()).toHaveLength(1);
  });

  it('when no issue exists, the expired lease is released to the resting status, and the next attempt files once', async () => {
    const db = await freshDb();
    await seedCohort(db);
    const env = githubEnv(db, 'issues');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runProposalStage(env, budget(), NOW, { fetchImpl: fakeGithub({ createStatus: 503 }).fetchImpl, draftModel: stubModel().model });
    let [p] = await proposals(db);
    expect(p.status).toBe('filing');
    const gh = fakeGithub();
    const out = await fileProposal(env, String(p.id), later(FILING_LEASE_MS + 1_000), { operator: false, actor: 'system', fetchImpl: gh.fetchImpl });
    expect(out).toEqual({ kind: 'released' });
    [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'proposed', filing_lease_until: null }); // never accepted by an operator
    await runProposalStage(env, budget(), later(FILING_LEASE_MS + 60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    [p] = await proposals(db);
    expect(p.status).toBe('issue_filed');
    expect(gh.posts()).toHaveLength(1);
  });

  it('stuck filings whose evidence was withdrawn do not starve a fileable proposal of the 3 filing slots', async () => {
    const db = await freshDb(['lrn_a', 'lrn_b', 'lrn_c', 'lrn_d', 'lrn_e', 'lrn_f']);
    for (const t of ['quiz typo', 'concept example outdated', 'lab score wrong']) await seedCohort(db, LEARNERS, { topic_key: t, area: 'concepts' });
    await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
    // Three crashed filings, older than everything else, and their learners then revoke.
    await db.prepare(`UPDATE insight_proposals SET status = 'filing', filing_lease_until = ?, updated_at = ?`)
      .bind(new Date(NOW.getTime() - 60_000).toISOString(), new Date(NOW.getTime() - 3_600_000).toISOString()).run();
    await WITHDRAWALS[0][1](db, LEARNERS);
    // A fresh cohort reports a different problem that passes the gate.
    await seedCohort(db, ['lrn_d', 'lrn_e', 'lrn_f'], { topic_key: 'hint missing link', area: 'concepts' });
    const env = githubEnv(db, 'issues');
    const gh = fakeGithub();
    for (let i = 1; i <= 2; i++) {
      await runProposalStage(env, budget(), later(i * 15 * 60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    }
    const rows = await proposals(db);
    expect(rows.filter((r) => r.status === 'filing')).toHaveLength(0);
    expect(rows.filter((r) => r.status === 'issue_filed')).toHaveLength(1);
    expect(rows.filter((r) => r.draft_json === '{}')).toHaveLength(3);
    expect(gh.posts()).toHaveLength(1);
  });
});
