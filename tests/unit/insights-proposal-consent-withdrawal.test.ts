/**
 * Proposals follow the CURRENT consented evidence: when learners revoke `proposals` consent, delete their
 * reports or their account, no filing path (an accepted proposal, the operator's `file_issue`, the cron's
 * lease recovery) may publish anything, the stored draft built from that evidence is withdrawn (or rebuilt
 * from the evidence-free template while the cohort still stands, voiding decisions taken on the old text),
 * and a proposal below the cohort is hidden from operators. Also: no proposal stays stuck in `filing`, with
 * GitHub on or off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { setSafeAutoImplement } from '../../src/lib/insights/operator-settings';
import { fileProposal, proposalDetail, runProposalStage } from '../../src/lib/insights/proposal-stage';
import { applyTriage, approveAiHandle, FILING_LEASE_MS, listProposalSummaries } from '../../src/lib/insights/proposal-store';
import { GET as detailRoute, PATCH as patchRoute } from '../../src/pages/api/v1/admin/insights/proposals/[id]';
import { learnerCtx, routeContext } from './observer-seed-fixtures';
import { addLearner, baseEnv, fakeGithub, freshDb, githubEnv, NOW, seedCohort, stubModel } from './insights-proposal-stage-fixtures';

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

    // Operators no longer see the proposal at all (no title, no count) while the cohort is below 3.
    expect(await proposalDetail(env, id, later(120_000))).toBeNull();
    expect(await listProposalSummaries(db, null, later(120_000))).toEqual([]);
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

  it('hides a proposal below the cohort from the admin detail and action routes, and shows it again once the cohort is back', async () => {
    const { db, id } = await acceptedProposal();
    await WITHDRAWALS[2][1](db, LEARNERS);
    const url = `https://unlock.zuey.me/api/v1/admin/insights/proposals/${id}`;
    const env = { DB: db, INSIGHTS_MODE: 'internal' };
    const admin = learnerCtx('lrn_admin', { isAdmin: true });
    const res = await detailRoute(routeContext({ learner: admin, env, params: { id }, url, request: new Request(url) }) as never);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('hint unclear');
    const patch = await patchRoute(routeContext({
      learner: admin, env, params: { id }, url,
      request: new Request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reject' }) }),
    }) as never);
    expect(patch.status).toBe(404);
    expect((await proposals(db))[0].status).toBe('accepted'); // untouched

    // Three new established learners report the problem again: the proposal is listed again.
    for (const l of ['lrn_x', 'lrn_y', 'lrn_z']) await addLearner(db, l);
    await seedCohort(db, ['lrn_x', 'lrn_y', 'lrn_z']);
    expect(await listProposalSummaries(db, null, NOW)).toEqual([]); // not linked as evidence yet
    await runProposalStage(baseEnv(db), budget(), later(60_000), { draftModel: stubModel().model });
    const listed = await listProposalSummaries(db, null, NOW);
    expect(listed.map((p) => p.id)).toEqual([id]);
    expect(listed[0].stats.learners).toBe(3);
  });

  it('one contributor leaving a cohort that still stands replaces the model draft with the template and voids the decisions on it', async () => {
    const { db, id } = await acceptedProposal(['lrn_a', 'lrn_b', 'lrn_c', 'lrn_d']);
    expect(await approveAiHandle(db, id, 'lrn_admin', NOW)).toBe(true);
    await WITHDRAWALS[0][1](db, ['lrn_a']);
    await setSafeAutoImplement(db, false, 'lrn_admin', NOW);
    const env = githubEnv(db, 'issues_ai_handle');
    const gh = fakeGithub();
    const r = await runProposalStage(env, budget(), later(60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r.draftsRefreshed).toBe(1);
    let [p] = await proposals(db);
    // The acceptance and the ai-handle approval were given on the AI draft, not on the template.
    expect(p).toMatchObject({ id, status: 'proposed', ai_handle_approved_by: null, decided_by: null });
    expect(JSON.parse(String(p.draft_json))).toMatchObject({ source: 'template', basis: [] });
    expect(gh.posts()).toHaveLength(0);

    // The operator files the template: no ai-handle, because the approval did not carry over.
    expect(await fileProposal(env, id, later(120_000), { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl }))
      .toMatchObject({ kind: 'filed', aiHandle: false });
    [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'issue_filed', ai_handle: 0 });
    expect(gh.issues[0].body).toContain('## Aggregated evidence (3 learners');
  });

  it('a replacement found at filing time voids the old ai-handle approval for that very filing', async () => {
    const { db, id } = await acceptedProposal(['lrn_a', 'lrn_b', 'lrn_c', 'lrn_d']);
    expect(await approveAiHandle(db, id, 'lrn_admin', NOW)).toBe(true);
    await setSafeAutoImplement(db, false, 'lrn_admin', NOW);
    await WITHDRAWALS[0][1](db, ['lrn_a']);
    const gh = fakeGithub();
    // No cron tick in between: the filing itself finds the stale draft.
    expect(await fileProposal(githubEnv(db, 'issues_ai_handle'), id, later(60_000), { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl }))
      .toMatchObject({ kind: 'filed', aiHandle: false });
    expect(gh.issues[0].labels).not.toContain('ai-handle');
    expect((await proposals(db))[0]).toMatchObject({ ai_handle_approved_by: null, decided_by: 'lrn_admin' });
  });

  it('accept first stores the current draft, so the decision is recorded for that text and kept', async () => {
    const { db, id } = await acceptedProposal(['lrn_a', 'lrn_b', 'lrn_c', 'lrn_d']);
    await applyTriage(db, id, 'reject', { actor: 'lrn_admin', now: NOW });
    await applyTriage(db, id, 'reopen', { actor: 'lrn_admin', now: NOW });
    await WITHDRAWALS[0][1](db, ['lrn_a']); // the stored AI draft is now stale, not yet refreshed
    const url = `https://unlock.zuey.me/api/v1/admin/insights/proposals/${id}`;
    const res = await patchRoute(routeContext({
      learner: learnerCtx('lrn_admin', { isAdmin: true }), env: { DB: db, INSIGHTS_MODE: 'internal' }, params: { id }, url,
      request: new Request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept' }) }),
    }) as never);
    expect(res.status).toBe(200);
    let [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'accepted', decided_by: 'lrn_admin' });
    expect(JSON.parse(String(p.draft_json))).toMatchObject({ source: 'template' });
    // The cron finds nothing left to replace, so the acceptance stands.
    await runProposalStage(baseEnv(db), budget(), later(60_000), { draftModel: stubModel().model });
    [p] = await proposals(db);
    expect(p).toMatchObject({ status: 'accepted', decided_by: 'lrn_admin' });
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
  /** A proposal whose operator filing hit an ambiguous create (the issue exists, the client saw a 502). */
  async function ambiguousFiling(opts: { accepted?: boolean } = {}) {
    const db = await freshDb();
    await seedCohort(db);
    const env = githubEnv(db, 'issues');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gh = fakeGithub({ createStatusAfterCreate: 502, searchLag: true });
    await runProposalStage(env, budget(), NOW, { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    const [p] = await proposals(db);
    if (opts.accepted) await applyTriage(db, String(p.id), 'accept', { actor: 'lrn_admin', now: NOW });
    expect(await fileProposal(env, String(p.id), NOW, { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl })).toMatchObject({ kind: 'github_error' });
    expect((await proposals(db))[0].status).toBe('filing');
    return { db, env, gh, id: String(p.id) };
  }

  it('with GitHub switched off, an expired filing returns to its resting status without any network call', async () => {
    for (const accepted of [false, true]) {
      const { db, gh } = await ambiguousFiling({ accepted });
      const calls = gh.calls.length;
      const r = await runProposalStage(baseEnv(db), budget(), later(FILING_LEASE_MS + 1_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
      expect(r).toMatchObject({ githubMode: 'off', filingsReleased: 1 });
      const [p] = await proposals(db);
      expect(p).toMatchObject({ status: accepted ? 'accepted' : 'proposed', filing_lease_until: null, github_issue_number: null });
      expect(gh.calls).toHaveLength(calls);
      // The fingerprint claim survives the release.
      expect(await db.prepare(`SELECT status FROM insight_issue_filings`).first('status')).toBe('creating');
    }
  });

  it('a filing that is not expired yet stays in filing while GitHub is off', async () => {
    const { db } = await ambiguousFiling();
    const r = await runProposalStage(baseEnv(db), budget(), later(30_000), { draftModel: stubModel().model });
    expect(r.filingsReleased).toBe(0);
    expect((await proposals(db))[0].status).toBe('filing');
  });

  it('after the release, turning GitHub back on links the issue the ambiguous create made instead of filing again', async () => {
    const { db, env, gh, id } = await ambiguousFiling();
    await runProposalStage(baseEnv(db), budget(), later(FILING_LEASE_MS + 1_000), { draftModel: stubModel().model });
    expect(await fileProposal(env, id, later(FILING_LEASE_MS + 60_000), { operator: true, actor: 'lrn_admin', fetchImpl: gh.fetchImpl }))
      .toMatchObject({ kind: 'linked', number: 100 });
    expect(gh.posts()).toHaveLength(1);
    expect((await proposals(db))[0]).toMatchObject({ status: 'issue_filed', github_issue_number: 100 });
  });

  it('stuck filings whose evidence was withdrawn are released and withdrawn, and never filed', async () => {
    const db = await freshDb(['lrn_a', 'lrn_b', 'lrn_c', 'lrn_d', 'lrn_e', 'lrn_f']);
    for (const t of ['quiz typo', 'concept example outdated', 'lab score wrong']) await seedCohort(db, LEARNERS, { topic_key: t, area: 'concepts' });
    await runProposalStage(baseEnv(db), budget(), NOW, { draftModel: stubModel().model });
    // Three crashed filings, and their learners then revoke.
    await db.prepare(`UPDATE insight_proposals SET status = 'filing', filing_lease_until = ?, updated_at = ?`)
      .bind(new Date(NOW.getTime() - 60_000).toISOString(), new Date(NOW.getTime() - 3_600_000).toISOString()).run();
    await WITHDRAWALS[0][1](db, LEARNERS);
    const env = githubEnv(db, 'issues');
    const gh = fakeGithub();
    const r = await runProposalStage(env, budget(), later(15 * 60_000), { fetchImpl: gh.fetchImpl, draftModel: stubModel().model });
    expect(r).toMatchObject({ filingsReleased: 3, filed: 0 });
    const rows = await proposals(db);
    expect(rows.filter((x) => x.status === 'filing')).toHaveLength(0);
    expect(rows.filter((x) => x.draft_json === '{}')).toHaveLength(3);
    expect(gh.posts()).toHaveLength(0);
  });
});
