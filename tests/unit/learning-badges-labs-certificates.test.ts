import { beforeEach, describe, expect, it } from 'vitest';
import type { Badge } from '../../src/lib/content/parse-content';
import { listPublishedMissions } from '../../src/lib/content/loader';
import { badgeRuleMet, eligibleBadges, type BadgeContext } from '../../src/lib/learning/badges';
import { GUEST_CERTIFICATE_PROMPT } from '../../src/lib/learning/certificate-messages';
import { hasStrongVerify, newCertificateCode } from '../../src/lib/learning/certificates';
import { buildMissionList } from '../../src/lib/learning/progress';
import {
  getRecap, issueCertificate, listMissions, recordClientEvent, recordConceptView, recordLabResult, startMission, updateLearnerProfile,
} from '../../src/lib/learning/service';
import type { LearnerContext } from '../../src/lib/learning/types';
import { fakeEnv, seedLearner, type FakeEnv } from './learning-fake-env';

const NOW = new Date('2026-10-26T03:00:00Z');
const badge = (rule: Badge['rule']): Badge => ({ id: `b-${rule.kind}`, name: 'B', emoji: '⭐', description: 'd', rule });
const ctx = (over: Partial<BadgeContext> = {}): BadgeContext => ({
  completedMissionIds: new Set(), competency: new Map(), labsDone: 0, streakDays: 0, ...over,
});

describe('badge rules', () => {
  const missions = listPublishedMissions();
  it('evaluates every rule kind', () => {
    expect(badgeRuleMet(badge({ kind: 'first_pass' }), ctx({ completedMissionIds: new Set(['m']) }), missions)).toBe(true);
    expect(badgeRuleMet(badge({ kind: 'missions_completed', count: 2 }), ctx({ completedMissionIds: new Set(['m']) }), missions)).toBe(false);
    expect(badgeRuleMet(badge({ kind: 'mission_completed', mission: 'plan-weekend' }), ctx({ completedMissionIds: new Set(['plan-weekend']) }), missions)).toBe(true);
    expect(badgeRuleMet(badge({ kind: 'competency_score', competency: 'verify', min: 0.8 }), ctx({ competency: new Map([['verify', 0.8]]) }), missions)).toBe(true);
    expect(badgeRuleMet(badge({ kind: 'labs_completed', count: 3 }), ctx({ labsDone: 2 }), missions)).toBe(false);
    expect(badgeRuleMet(badge({ kind: 'streak_days', count: 3 }), ctx({ streakDays: 3 }), missions)).toBe(true);
    expect(badgeRuleMet(badge({ kind: 'no_hint_pass' }), ctx(), missions)).toBe(false);
    const pass = (over: Partial<NonNullable<BadgeContext['pass']>> = {}) => ({ missionId: 'plan-weekend', hintsUsed: 1, confidence: null, score: 0.8, ...over });
    expect(badgeRuleMet(badge({ kind: 'no_hint_pass' }), ctx({ pass: pass({ hintsUsed: 0 }) }), missions)).toBe(true);
    // confidence is 0..100, `within` is on the 0..1 scale
    expect(badgeRuleMet(badge({ kind: 'calibrated', within: 0.1 }), ctx({ pass: pass({ confidence: 75 }) }), missions)).toBe(true);
    expect(badgeRuleMet(badge({ kind: 'calibrated', within: 0.1 }), ctx({ pass: pass({ confidence: 50 }) }), missions)).toBe(false);
    // plan-weekend ↔ plan-family-trip are each other's transfer_variant
    const both = new Set(['plan-weekend', 'plan-family-trip']);
    expect(badgeRuleMet(badge({ kind: 'transfer_pass' }), ctx({ completedMissionIds: both, pass: pass({ missionId: 'plan-family-trip' }) }), missions)).toBe(true);
    expect(badgeRuleMet(badge({ kind: 'transfer_pass' }), ctx({ completedMissionIds: new Set(['plan-family-trip']), pass: pass({ missionId: 'plan-family-trip' }) }), missions)).toBe(false);
    expect(badgeRuleMet(badge({ kind: 'transfer_pass' }), ctx({ completedMissionIds: both }), missions)).toBe(false);
  });
  it('skips badges already held', () => {
    expect(eligibleBadges([badge({ kind: 'first_pass' })], ctx({ completedMissionIds: new Set(['m']) }), missions, new Set(['b-first_pass']))).toEqual([]);
  });
});

describe('mission recommendations', () => {
  it('recommends unfinished missions matching the profile', () => {
    const [m] = listPublishedMissions();
    const work = { ...m, id: 'work-mission', persona_tags: ['work' as const], estimated_minutes: 20 };
    const list = buildMissionList([m, work], { goal: 'work', familiarity: 'regular' }, new Set(), new Set([m.id]));
    expect(list.find((x) => x.id === 'work-mission')).toMatchObject({ status: 'new', recommended: true });
    expect(list.find((x) => x.id === m.id)?.status).toBe('in_progress');
    const done = buildMissionList([m, work], {}, new Set([m.id]), new Set());
    expect(done.find((x) => x.id === m.id)).toMatchObject({ status: 'completed', recommended: false });
  });
});

describe('labs, concepts, events, profile, recap, certificates', () => {
  let env: FakeEnv;
  let alice: LearnerContext;
  let bob: LearnerContext;
  const deps = () => ({ env, now: () => NOW });
  beforeEach(async () => {
    env = fakeEnv();
    alice = await seedLearner(env.DB, 'lrn_alice');
    bob = await seedLearner(env.DB, 'lrn_bob');
    await env.DB.prepare("UPDATE learners SET kind = 'member' WHERE id = 'lrn_alice'").run();
    alice = { ...alice, kind: 'member' };
  });

  it('records lab results without XP', async () => {
    const r = await recordLabResult(deps(), alice, 'token-predictor', { correct: 4, total: 5 });
    expect(r.labsDone).toEqual(['token-predictor']);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM xp_ledger').first<{ n: number }>())?.n).toBe(0);
    await expect(recordLabResult(deps(), alice, 'unknown-lab', {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(recordLabResult(deps(), alice, 'context-lab', { blob: 'x'.repeat(5000) })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('records a concept view once', async () => {
    await recordConceptView(deps(), alice, 'prompt');
    await recordConceptView(deps(), alice, 'prompt');
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE name = 'concept.viewed'`).first<{ n: number }>())?.n).toBe(1);
    await expect(recordConceptView(deps(), alice, 'nope-concept')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('accepts only allow-listed client events and owned runs', async () => {
    const run = await startMission(deps(), alice, 'plan-weekend', 'web');
    await recordClientEvent(deps(), alice, { name: 'mission.step_viewed', runId: run.id, props: { stepId: 'intro' } });
    await expect(recordClientEvent(deps(), alice, { name: 'xp.granted' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(recordClientEvent(deps(), bob, { name: 'mission.step_viewed', runId: run.id, props: { stepId: 'intro' } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(recordClientEvent(deps(), alice, { name: 'mission.step_viewed', runId: run.id })).rejects.toMatchObject({ code: 'invalid' });
    await expect(recordClientEvent(deps(), alice, { name: 'mission.step_completed', props: { stepId: 'intro' } })).rejects.toMatchObject({ code: 'invalid' });
    await recordClientEvent(deps(), alice, { name: 'lab.started', props: { labId: 'context-lab' } });
    await expect(recordClientEvent(deps(), alice, { name: 'lab.started', props: { nested: { a: 1 } } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('merges profile updates and validates them', async () => {
    const updated = await updateLearnerProfile(deps(), alice, { profile: { goal: 'work', timezone: 'Asia/Tokyo' }, displayName: '  Linh ' });
    expect(updated).toMatchObject({ displayName: 'Linh', profile: { goal: 'work', timezone: 'Asia/Tokyo' } });
    const row = await env.DB.prepare('SELECT profile_json FROM learners WHERE id = ?').bind(alice.id).first<{ profile_json: string }>();
    expect(JSON.parse(row!.profile_json)).toEqual({ goal: 'work', timezone: 'Asia/Tokyo' });
    await expect(updateLearnerProfile(deps(), alice, { profile: { timezone: 'Mars/Base' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(updateLearnerProfile(deps(), alice, { profile: { isAdmin: true } as never })).rejects.toMatchObject({ code: 'invalid' });
    expect((await listMissions(deps(), updated)).length).toBeGreaterThan(0);
  });

  it('builds an empty recap without errors', async () => {
    expect(await getRecap(deps(), alice, 'week')).toEqual({ period: 'week', missionsCompleted: 0, xpGained: 0, competencyDeltas: [], highlights: [], reflections: [] });
  });

  it('issues certificates only when eligible, once per level', async () => {
    await expect(issueCertificate(deps(), alice, 'Linh')).rejects.toMatchObject({ code: 'forbidden' });
    const at = NOW.toISOString();
    for (const m of ['m-one', 'm-two', 'm-three']) {
      await env.DB.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, started_at, updated_at, completed_at) VALUES (?, ?, ?, 1, 'completed', ?, ?, ?)`)
        .bind(`run_${m}`, alice.id, m, at, at, at).run();
    }
    await env.DB.prepare(`INSERT INTO evidence_submissions (id, run_id, learner_id, idempotency_key, answers_json, created_at) VALUES ('sub_1', 'run_m-one', ?, 'k', '{}', ?)`).bind(alice.id, at).run();
    const criteria = JSON.stringify([{ id: 'c', label: 'c', weight: 1, score: 0.85, method: 'ai', competency: 'verify', feedback: '' }]);
    await env.DB.prepare(`INSERT INTO evaluations (id, run_id, submission_id, learner_id, status, score, criteria_json, feedback, mode, created_at) VALUES ('evl_1', 'run_m-one', 'sub_1', ?, 'passed', 0.85, ?, 'ok', 'mixed', ?)`)
      .bind(alice.id, criteria, at).run();
    // A qualifying guest is asked to sign in instead of getting a public page.
    await expect(issueCertificate(deps(), { ...alice, kind: 'guest' }, 'Linh')).rejects.toMatchObject({ code: 'forbidden', message: GUEST_CERTIFICATE_PROMPT });
    const cert = await issueCertificate(deps(), alice, 'Linh Nguyễn');
    expect(cert.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(cert.url).toBe(`https://unlock.zuey.me/certificates/${cert.code}`);
    expect((await issueCertificate(deps(), alice, 'Linh')).code).toBe(cert.code);
    const snap = await env.DB.prepare('SELECT snapshot_json FROM certificates WHERE code = ?').bind(cert.code).first<{ snapshot_json: string }>();
    expect(JSON.parse(snap!.snapshot_json)).toMatchObject({ level: 'L0', missions: expect.any(Array), competencies: expect.any(Array) });
    await expect(issueCertificate(deps(), bob, 'Bob')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(issueCertificate(deps(), alice, '   ')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('counts only the first passing evaluation of each mission toward the strong-verify condition', async () => {
    const seedPass = async (n: number, missionId: string, verify: number, at: string) => {
      await env.DB.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, started_at, updated_at, completed_at) VALUES (?, ?, ?, 1, 'completed', ?, ?, ?)`)
        .bind(`run_${n}`, alice.id, missionId, at, at, at).run();
      await env.DB.prepare(`INSERT INTO evidence_submissions (id, run_id, learner_id, idempotency_key, answers_json, created_at) VALUES (?, ?, ?, ?, '{}', ?)`)
        .bind(`sub_${n}`, `run_${n}`, alice.id, `k${n}`, at).run();
      const criteria = JSON.stringify([{ id: 'c', label: 'c', weight: 1, score: verify, method: 'ai', competency: 'verify', feedback: '' }]);
      await env.DB.prepare(`INSERT INTO evaluations (id, run_id, submission_id, learner_id, status, score, criteria_json, feedback, mode, created_at) VALUES (?, ?, ?, ?, 'passed', ?, ?, 'ok', 'mixed', ?)`)
        .bind(`evl_${n}`, `run_${n}`, `sub_${n}`, alice.id, verify, criteria, at).run();
    };
    await seedPass(1, 'm-one', 0.6, '2026-10-01T00:00:00.000Z');
    // A later repeat pass of the same mission scoring high does not count.
    await seedPass(2, 'm-one', 0.95, '2026-10-02T00:00:00.000Z');
    expect(await hasStrongVerify(env.DB, alice.id)).toBe(false);
    // The first pass of another mission does.
    await seedPass(3, 'm-two', 0.85, '2026-10-03T00:00:00.000Z');
    expect(await hasStrongVerify(env.DB, alice.id)).toBe(true);
  });

  it('certificate codes use the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) expect(newCertificateCode()).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
  });
});
