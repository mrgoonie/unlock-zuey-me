/**
 * Evidence ownership across a guest → member merge, mission XP once per mission, completed missions opening
 * on their result, one open run per mission, and the atomic submission claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeMemberSignIn } from '../../src/lib/identity/member-sign-in';
import {
  getProgress, getRun, openMission, readEvidence, saveAnswers, startMission, storeEvidenceImage, submitEvidence, type LearningDeps,
} from '../../src/lib/learning/service';
import type { LearnerContext } from '../../src/lib/learning/types';
import { getLearnerDetail, getObservedLearner } from '../../src/lib/observer/queries';
import {
  failingFetch, fakeEnv, gradeAll, openRouterFetch, planWeekendAnswers, seedLearner, type FakeEnv,
} from './learning-fake-env';

const NOW = new Date('2026-10-26T03:00:00Z');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let env: FakeEnv;
let guest: LearnerContext;

const count = async (sql: string, ...args: unknown[]) => Number((await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n);
const passing = (): LearningDeps => ({ env, now: () => NOW, fetchImpl: openRouterFetch((b) => gradeAll(b, 0.9)).fetchImpl });

async function fillAll(deps: LearningDeps, learner: LearnerContext, runId: string) {
  let run = await getRun(deps, learner, runId);
  for (const [stepId, answers] of Object.entries(planWeekendAnswers)) run = await saveAnswers(deps, learner, runId, { stepId, answers, rev: run.rev });
  return run;
}

async function seedMember(id: string, consent: boolean): Promise<LearnerContext> {
  await env.DB.prepare(`INSERT INTO learners (id, kind, zuey_sub, observer_consent, created_at, updated_at) VALUES (?, 'member', 'zuey-42', ?, ?, ?)`)
    .bind(id, consent ? 1 : 0, NOW.toISOString(), NOW.toISOString()).run();
  return { id, kind: 'member', email: null, displayName: null, avatarUrl: null, isAdmin: false, observerConsent: consent, profile: {} };
}

const mergeGuestInto = () => completeMemberSignIn(env.DB, {
  userinfo: { sub: 'zuey-42', email: 'm@example.com', emailVerified: true, name: 'M', picture: null },
  current: { id: guest.id, kind: 'guest' }, oldSessionToken: undefined, now: NOW,
});

const admin: LearnerContext = { id: 'lrn_admin', kind: 'member', email: 'a@example.com', displayName: null, avatarUrl: null, isAdmin: true, observerConsent: false, profile: {} };

beforeEach(async () => {
  env = fakeEnv();
  guest = await seedLearner(env.DB, 'lrn_guest', { observerConsent: true });
});

describe('evidence after a guest → member merge', () => {
  it('lets the member read and re-grade pre-merge images; admin access follows the member consent', async () => {
    const deps = { env, now: () => NOW };
    const run = await startMission(deps, guest, 'plan-weekend', 'web');
    await fillAll(deps, guest, run.id);
    const key = await storeEvidenceImage(env, guest, PNG);
    env.AI.run.mockRejectedValue(new Error('workers ai down'));
    const failed = await submitEvidence({ ...deps, fetchImpl: failingFetch() }, guest, run.id, { idempotencyKey: 'key-00000001', imageKeys: [key], source: 'web' });
    expect(failed.run.status).toBe('evaluation_failed');

    const member = await seedMember('lrn_member', false);
    expect((await mergeGuestInto()).guestOutcome).toBe('merged');

    // Owner reads the image (key still has the guest prefix); strangers and the merged guest id do not.
    expect(await readEvidence(env, member, key)).toBeTruthy();
    const stranger = await seedLearner(env.DB, 'lrn_stranger');
    await expect(readEvidence(env, stranger, key)).rejects.toMatchObject({ code: 'not_found' });

    // "Chấm lại": a retry re-uses the stored submission and its pre-merge image keys.
    const retry = await submitEvidence(passing(), member, run.id, { idempotencyKey: 'key-00000002', source: 'web' });
    expect(retry.evaluation.status).toBe('passed');
    const subs = await env.DB.prepare('SELECT image_keys_json FROM evidence_submissions WHERE run_id = ? ORDER BY created_at, rowid').bind(run.id).all<{ image_keys_json: string }>();
    expect(JSON.parse(subs.results.at(-1)!.image_keys_json)).toEqual([key]);

    // Admin: the guest row consented, but the member did not → hidden. Member consents → visible.
    await expect(readEvidence(env, admin, key)).rejects.toMatchObject({ code: 'not_found' });
    await env.DB.prepare('UPDATE learners SET observer_consent = 1 WHERE id = ?').bind(member.id).run();
    expect(await readEvidence(env, admin, key)).toBeTruthy();
    await env.DB.prepare('UPDATE learners SET observer_consent = 0 WHERE id = ?').bind(member.id).run();
    await expect(readEvidence(env, admin, key)).rejects.toMatchObject({ code: 'not_found' });

    // The merged guest row is no longer observable on its own.
    expect(await getObservedLearner(env.DB, guest.id)).toBeNull();
    expect(await getLearnerDetail(env.DB, guest.id)).toBeNull();
  });

  it('accepts a pre-merge draft image on a fresh submission by the member', async () => {
    const deps = passing();
    const run = await startMission(deps, guest, 'plan-weekend', 'web');
    await fillAll(deps, guest, run.id);
    const key = await storeEvidenceImage(env, guest, PNG);
    const member = await seedMember('lrn_member', true);
    await mergeGuestInto();
    const res = await submitEvidence(deps, member, run.id, { idempotencyKey: 'key-00000001', imageKeys: [key], source: 'web' });
    expect(res.evaluation.status).toBe('passed');
  });

  it('abandons the older open run when guest and member both had the mission open', async () => {
    const member = await seedMember('lrn_member', false);
    const older = await startMission({ env, now: () => new Date(NOW.getTime() - 60_000) }, member, 'plan-weekend', 'web');
    const newer = await startMission({ env, now: () => NOW }, guest, 'plan-weekend', 'web');
    await mergeGuestInto();
    const rows = await env.DB.prepare(`SELECT id, status FROM mission_runs WHERE learner_id = ? ORDER BY id`).bind(member.id).all<{ id: string; status: string }>();
    expect(Object.fromEntries(rows.results.map((r) => [r.id, r.status]))).toEqual({ [older.id]: 'abandoned', [newer.id]: 'started' });
    expect((await getProgress({ env }, member)).activeRuns.map((r) => r.id)).toEqual([newer.id]);
  });
});

describe('repeat runs', () => {
  it('pays mission XP once; a completed mission opens on its result and "again" starts a new run', async () => {
    const deps = passing();
    const first = await startMission(deps, guest, 'plan-weekend', 'web');
    await fillAll(deps, guest, first.id);
    const pass1 = await submitEvidence(deps, guest, first.id, { idempotencyKey: 'key-00000001', source: 'web' });
    expect(pass1.rewards.xpGained).toBeGreaterThan(0);

    // Opening the mission again shows the completed run instead of silently starting a new one.
    const opened = await openMission(deps, guest, 'plan-weekend', 'web');
    expect(opened).toMatchObject({ id: first.id, status: 'completed' });
    expect(await count('SELECT COUNT(*) AS n FROM mission_runs WHERE learner_id = ?', guest.id)).toBe(1);

    const again = await startMission(deps, guest, 'plan-weekend', 'web');
    expect(again.id).not.toBe(first.id);
    expect((await openMission(deps, guest, 'plan-weekend', 'web')).id).toBe(again.id);
    await fillAll(deps, guest, again.id);
    const pass2 = await submitEvidence(deps, guest, again.id, { idempotencyKey: 'key-00000002', source: 'web' });
    expect(pass2.evaluation.status).toBe('passed');
    expect(pass2.rewards.xpGained).toBe(0);
    expect(pass2.rewards.xpTotal).toBe(pass1.rewards.xpTotal);
    expect(await count('SELECT COUNT(*) AS n FROM xp_ledger WHERE learner_id = ?', guest.id)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM evaluations WHERE learner_id = ? AND status = 'passed'`, guest.id)).toBe(2);
  });

  it('allows one open run per mission, even under concurrent starts', async () => {
    const deps = { env, now: () => NOW };
    const [a, b] = await Promise.all([startMission(deps, guest, 'plan-weekend', 'web'), startMission(deps, guest, 'plan-weekend', 'mcp')]);
    expect(a.id).toBe(b.id);
    const dup = env.DB.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, started_at, updated_at) VALUES ('run_dup', ?, 'plan-weekend', 1, 'started', 'x', 'x')`).bind(guest.id).run();
    await expect(dup).rejects.toThrow(/UNIQUE/);
  });
});

describe('atomic submission claim', () => {
  it('stores exactly one submission when two submits race on the same rev', async () => {
    const deps = passing();
    const run = await startMission(deps, guest, 'plan-weekend', 'web');
    await fillAll(deps, guest, run.id);
    const results = await Promise.allSettled([
      submitEvidence(deps, guest, run.id, { idempotencyKey: 'key-00000001', source: 'web' }),
      submitEvidence(deps, guest, run.id, { idempotencyKey: 'key-00000002', source: 'web' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect(await count('SELECT COUNT(*) AS n FROM evidence_submissions WHERE run_id = ?', run.id)).toBe(1);
  });

  it('drops a stale evaluation that finishes after a retry re-claimed the run', async () => {
    const deps = passing();
    const run = await startMission(deps, guest, 'plan-weekend', 'web');
    await fillAll(deps, guest, run.id);
    // The first grading hangs until released; meanwhile the run counts as stuck and the learner retries.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = openRouterFetch((b) => gradeAll(b, 0.2));
    const slowFetch = (async (...args: Parameters<typeof fetch>) => { await gate; return slow.fetchImpl(...args); }) as typeof fetch;
    const first = submitEvidence({ env, now: () => NOW, fetchImpl: slowFetch }, guest, run.id, { idempotencyKey: 'key-00000001', source: 'web' });
    await vi.waitFor(async () => expect((await getRun(deps, guest, run.id)).status).toBe('evaluating'));

    const later = new Date(NOW.getTime() + 10 * 60_000);
    const retry = await submitEvidence({ ...passing(), now: () => later }, guest, run.id, { idempotencyKey: 'key-00000002', source: 'web' });
    expect(retry.evaluation.status).toBe('passed');
    const competenciesAfterRetry = await env.DB.prepare('SELECT competency, score, evidence_count FROM competency_scores WHERE learner_id = ? ORDER BY competency').bind(guest.id).all();

    release();
    await expect(first).rejects.toMatchObject({ code: 'conflict' });
    expect(await count('SELECT COUNT(*) AS n FROM evaluations WHERE run_id = ?', run.id)).toBe(1);
    expect(await getRun(deps, guest, run.id)).toMatchObject({ status: 'completed', rev: retry.run.rev });
    const competencies = await env.DB.prepare('SELECT competency, score, evidence_count FROM competency_scores WHERE learner_id = ? ORDER BY competency').bind(guest.id).all();
    expect(competencies.results).toEqual(competenciesAfterRetry.results);
    expect(competencies.results.every((c) => c.evidence_count === 1)).toBe(true);
  });

  it('never leaves a claimed run without its submission (claim and insert are one batch)', async () => {
    const deps = passing();
    const run = await startMission(deps, guest, 'plan-weekend', 'web');
    const filled = await fillAll(deps, guest, run.id);
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = (() => Promise.reject(new Error('worker died'))) as typeof env.DB.batch;
    await expect(submitEvidence(deps, guest, run.id, { idempotencyKey: 'key-00000001', source: 'web' })).rejects.toThrow('worker died');
    env.DB.batch = batch;
    expect(await getRun(deps, guest, run.id)).toMatchObject({ status: filled.status, rev: filled.rev });
    expect(await count('SELECT COUNT(*) AS n FROM evidence_submissions WHERE run_id = ?', run.id)).toBe(0);
  });
});
