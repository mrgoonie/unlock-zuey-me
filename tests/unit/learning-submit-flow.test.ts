import { beforeEach, describe, expect, it } from 'vitest';
import { WORKERS_AI_MODEL } from '../../src/lib/coach/ai-models';
import {
  getProgress, getRun, getRunWithEvaluation, requestHint, saveAnswers, startMission, storeEvidenceImage, submitEvidence,
  type LearningDeps,
} from '../../src/lib/learning/service';
import { RunConflictError } from '../../src/lib/learning/errors';
import { LearningError, type LearnerContext } from '../../src/lib/learning/types';
import {
  failingFetch, fakeEnv, gradeAll, openRouterFetch, planWeekendAnswers, seedLearner, type FakeEnv,
} from './learning-fake-env';

const NOW = new Date('2026-10-26T03:00:00Z');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let env: FakeEnv;
let alice: LearnerContext;
let bob: LearnerContext;

async function fillAll(deps: LearningDeps, learner: LearnerContext, runId: string) {
  let run = await getRun(deps, learner, runId);
  for (const [stepId, answers] of Object.entries(planWeekendAnswers)) run = await saveAnswers(deps, learner, runId, { stepId, answers, rev: run.rev });
  return run;
}

const count = async (sql: string, ...args: unknown[]) => Number((await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n);

beforeEach(async () => {
  env = fakeEnv();
  alice = await seedLearner(env.DB, 'lrn_alice');
  bob = await seedLearner(env.DB, 'lrn_bob');
});

describe('runs and answers', () => {
  it('starts once and resumes the open run', async () => {
    const deps = { env, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    expect(run).toMatchObject({ status: 'started', currentStep: 'intro', rev: 0, learnerId: alice.id });
    expect((await startMission(deps, alice, 'plan-weekend', 'mcp')).id).toBe(run.id);
    await expect(startMission(deps, alice, 'nope', 'web')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('saves answers with optimistic rev and returns the current run on conflict', async () => {
    const deps = { env, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    const saved = await saveAnswers(deps, alice, run.id, { stepId: 'constraints', answers: { goal: 'Nghỉ ngơi cuối tuần' }, currentStep: 'constraints', rev: 0 });
    expect(saved.rev).toBe(1);
    const err = await saveAnswers(deps, alice, run.id, { stepId: 'constraints', answers: { goal: 'x' }, rev: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(RunConflictError);
    expect((err as RunConflictError).run.rev).toBe(1);
    expect((err as RunConflictError).run.answers.constraints.goal).toBe('Nghỉ ngơi cuối tuần');
    await expect(saveAnswers(deps, alice, run.id, { stepId: 'constraints', answers: { hacked: 'x' }, rev: 1 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(saveAnswers(deps, alice, run.id, { stepId: 'verify', answers: { 'claim-hours': 'maybe' }, rev: 1 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(saveAnswers(deps, alice, run.id, { stepId: 'constraints', answers: { goal: 'x'.repeat(9000) }, rev: 1 })).rejects.toMatchObject({ code: 'invalid' });
    const last = await saveAnswers(deps, alice, run.id, { stepId: 'reflect', answers: {}, currentStep: 'reflect', rev: 1 });
    expect(last.status).toBe('awaiting_evidence');
    // Advancing past steps emits mission.step_completed with props.stepId (observer funnel).
    const ev = await env.DB.prepare(`SELECT props_json FROM events WHERE name = 'mission.step_completed' ORDER BY rowid`).all<{ props_json: string }>();
    expect(ev.results.map((r) => JSON.parse(r.props_json).stepId)).toEqual(['intro', 'constraints']);
  });

  it('isolates learners: another learner’s run is not_found everywhere', async () => {
    const deps = { env, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    const nf = { code: 'not_found' };
    await expect(getRun(deps, bob, run.id)).rejects.toMatchObject(nf);
    await expect(getRunWithEvaluation(deps, bob, run.id)).rejects.toMatchObject(nf);
    await expect(saveAnswers(deps, bob, run.id, { stepId: 'constraints', answers: {}, rev: 0 })).rejects.toMatchObject(nf);
    await expect(requestHint(deps, bob, run.id, 'constraints', 1)).rejects.toMatchObject(nf);
    await expect(submitEvidence(deps, bob, run.id, { idempotencyKey: 'key-bob-0001', source: 'web' })).rejects.toMatchObject(nf);
    expect((await getProgress(deps, bob)).activeRuns).toHaveLength(0);
  });
});

describe('submitEvidence', () => {
  it('passes, grants XP and badges once, and replays idempotently', async () => {
    const { fetchImpl, calls } = openRouterFetch((b) => gradeAll(b, 0.9));
    const deps = { env, fetchImpl, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    await fillAll(deps, alice, run.id);
    const imageKey = await storeEvidenceImage(env, alice, PNG);

    const res = await submitEvidence(deps, alice, run.id, { idempotencyKey: 'key-00000001', confidence: 85, imageKeys: [imageKey], source: 'web' });
    expect(res.replayed).toBe(false);
    expect(res.evaluation).toMatchObject({ status: 'passed', score: 0.95, mode: 'mixed', graderModel: 'anthropic/claude-sonnet-5.5' });
    expect(res.run.status).toBe('completed');
    // 150 base + 30 no-hint + 30 calibration (|0.85 − 0.95| ≤ 0.15)
    expect(res.rewards.xpGained).toBe(210);
    expect(res.rewards.xpTotal).toBe(210);
    // first pass, verify/describe/reflect ≥ 0.8, no hints, calibrated (content/badges.yaml)
    expect(res.rewards.newBadges.map((b) => b.id).sort()).toEqual(
      ['clear-asker', 'fact-checker', 'first-verified-win', 'solo-pass', 'thoughtful-learner', 'well-calibrated'],
    );
    expect(res.rewards.streak).toMatchObject({ current: 1, activeToday: true });

    // OpenRouter request shape and image handling
    expect(calls).toHaveLength(1);
    const body = calls[0].body as { response_format: { json_schema: { strict: boolean } }; provider: { require_parameters: boolean }; messages: Array<{ content: string }> };
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider.require_parameters).toBe(true);
    expect(calls[0].headers['HTTP-Referer']).toBe('https://unlock.zuey.me');
    expect(calls[0].headers['X-Title']).toBeTruthy();
    expect(body.messages[1].content).toContain('[ảnh chụp màn hình đính kèm]');
    expect(body.messages[1].content).not.toContain(imageKey);

    const replay = await submitEvidence(deps, alice, run.id, { idempotencyKey: 'key-00000001', confidence: 85, source: 'web' });
    expect(replay.replayed).toBe(true);
    expect(replay.evaluation.id).toBe(res.evaluation.id);
    expect(replay.rewards.xpGained).toBe(210);
    expect(replay.rewards.xpTotal).toBe(210);
    expect(calls).toHaveLength(1);
    expect(await count('SELECT COUNT(*) AS n FROM xp_ledger WHERE learner_id = ?', alice.id)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM badge_grants WHERE learner_id = ?', alice.id)).toBe(6);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE name = 'xp.granted'`)).toBe(1);
    await expect(submitEvidence(deps, alice, run.id, { idempotencyKey: 'key-00000002', source: 'web' })).rejects.toMatchObject({ code: 'conflict' });

    const progress = await getProgress(deps, alice);
    expect(progress.xp).toBe(210);
    expect(progress.completedMissions).toEqual(['plan-weekend']);
    expect(progress.competencies.find((c) => c.id === 'verify')?.score).toBeCloseTo(0.95, 3);
  });

  it('never stores raw evidence text in event props', async () => {
    const { fetchImpl } = openRouterFetch((b) => gradeAll(b, 0.9));
    const deps = { env, fetchImpl, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    await fillAll(deps, alice, run.id);
    await submitEvidence(deps, alice, run.id, { idempotencyKey: 'key-00000001', source: 'web' });
    const { results } = await env.DB.prepare('SELECT props_json FROM events').all<{ props_json: string }>();
    for (const r of results) expect(r.props_json).not.toContain('Google Maps');
  });

  it('needs_revision grants nothing but still updates competencies', async () => {
    const { fetchImpl } = openRouterFetch((b) => gradeAll(b, 0.1));
    const deps = { env, fetchImpl, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    await fillAll(deps, alice, run.id);
    const res = await submitEvidence(deps, alice, run.id, { idempotencyKey: 'key-00000001', source: 'web' });
    expect(res.evaluation.status).toBe('needs_revision');
    expect(res.run.status).toBe('needs_revision');
    expect(res.rewards).toMatchObject({ xpGained: 0, xpTotal: 0, newBadges: [] });
    expect(await count('SELECT COUNT(*) AS n FROM competency_scores WHERE learner_id = ?', alice.id)).toBeGreaterThan(0);
  });

  it('keeps the submission when every AI path fails, then a retry re-evaluates it', async () => {
    env.AI.run.mockRejectedValue(new Error('workers ai down'));
    const run = await startMission({ env, now: () => NOW }, alice, 'plan-weekend', 'web');
    await fillAll({ env, now: () => NOW }, alice, run.id);
    const failed = await submitEvidence({ env, fetchImpl: failingFetch(), now: () => NOW }, alice, run.id, { idempotencyKey: 'key-00000001', source: 'web' });
    expect(failed.evaluation.status).toBe('failed');
    expect(failed.run.status).toBe('evaluation_failed');
    expect(failed.rewards.xpGained).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM evidence_submissions WHERE run_id = ?', run.id)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE name = 'evaluation.failed'`)).toBe(1);

    const { fetchImpl } = openRouterFetch((b) => gradeAll(b, 0.9));
    const retry = await submitEvidence({ env, fetchImpl, now: () => NOW }, alice, run.id, { idempotencyKey: 'key-00000002', source: 'web' });
    expect(retry.evaluation.status).toBe('passed');
    expect(retry.rewards.xpGained).toBe(180);
    const subs = await env.DB.prepare('SELECT answers_json FROM evidence_submissions WHERE run_id = ? ORDER BY created_at, rowid').bind(run.id).all<{ answers_json: string }>();
    expect(subs.results).toHaveLength(2);
    expect(subs.results[1].answers_json).toBe(subs.results[0].answers_json);
  });

  it('falls back to Workers AI with zod-validated JSON', async () => {
    env.AI.run.mockImplementation(async (_model: string, input: { messages: Array<{ content: string }> }) => {
      expect(input.messages.at(-1)?.content).toContain('JSON Schema');
      const ids = ['realistic-plan', 'real-check', 'adapt'];
      return { response: '```json\n' + JSON.stringify({ criteria: ids.map((id) => ({ id, score: 1, feedback: 'Tốt.' })), feedback: 'Ổn.', strengths: [], improvements: [] }) + '\n```' };
    });
    const deps = { env, fetchImpl: failingFetch(), now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    await fillAll(deps, alice, run.id);
    const res = await submitEvidence(deps, alice, run.id, { idempotencyKey: 'key-00000001', source: 'web' });
    expect(res.evaluation).toMatchObject({ status: 'passed', graderModel: WORKERS_AI_MODEL, score: 1 });
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE name = 'ai.fallback_used'`)).toBe(1);
  });

  it('rejects foreign image keys, bad keys and concurrent submits', async () => {
    const deps = { env, fetchImpl: openRouterFetch((b) => gradeAll(b, 0.9)).fetchImpl, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    await fillAll(deps, alice, run.id);
    const bobKey = await storeEvidenceImage(env, bob, PNG);
    await expect(submitEvidence(deps, alice, run.id, { idempotencyKey: 'key-00000001', imageKeys: [bobKey], source: 'web' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(submitEvidence(deps, alice, run.id, { idempotencyKey: 'bad key!', source: 'web' })).rejects.toBeInstanceOf(LearningError);
    await env.DB.prepare(`UPDATE mission_runs SET status = 'evaluating', updated_at = ? WHERE id = ?`).bind(NOW.toISOString(), run.id).run();
    await expect(submitEvidence(deps, alice, run.id, { idempotencyKey: 'key-00000003', source: 'web' })).rejects.toMatchObject({ code: 'conflict' });
    // A crashed evaluation (stale 'evaluating') can be retried.
    const later = { ...deps, now: () => new Date(NOW.getTime() + 10 * 60_000) };
    expect((await submitEvidence(later, alice, run.id, { idempotencyKey: 'key-00000004', source: 'web' })).evaluation.status).toBe('passed');
  });

  it('refuses an empty submission', async () => {
    const run = await startMission({ env, now: () => NOW }, alice, 'plan-weekend', 'web');
    await expect(submitEvidence({ env, now: () => NOW }, alice, run.id, { idempotencyKey: 'key-00000001', source: 'web' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
