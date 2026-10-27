/**
 * Reveal → abandon → retry: abandoning a run does not erase its penalties. The retry starts with the revealed
 * answers filled in and locked (so grading sees the original answer), and hints of the abandoned run still
 * cancel the no-hint XP bonus and badge. A "Làm lại" after completing the mission starts clean.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getMission } from '../../src/lib/content/loader';
import { carriedHintsUsed, carriedReveals } from '../../src/lib/learning/carried-penalties';
import { deterministicResults } from '../../src/lib/learning/evaluate-submission';
import {
  abandonRun, getRun, getRunWithEvaluation, openMission, requestHint, revealAnswer, saveAnswers, startMission, submitEvidence,
  type LearningDeps,
} from '../../src/lib/learning/service';
import type { LearnerContext } from '../../src/lib/learning/types';
import { fakeEnv, gradeAll, openRouterFetch, planWeekendAnswers, seedLearner, type FakeEnv } from './learning-fake-env';

const T0 = Date.parse('2026-10-26T03:00:00Z');
let env: FakeEnv;
let alice: LearnerContext;
let bob: LearnerContext;
let minute: number;
/** A clock that moves one minute per call site, so runs get distinct timestamps like in production. */
const deps = (extra: Partial<LearningDeps> = {}): LearningDeps => ({ env, now: () => new Date(T0 + minute * 60_000), ...extra });
const tick = () => { minute += 1; };

beforeEach(async () => {
  env = fakeEnv();
  env.AI.run.mockRejectedValue(new Error('workers ai down'));
  alice = await seedLearner(env.DB, 'lrn_alice');
  bob = await seedLearner(env.DB, 'lrn_bob');
  minute = 0;
});

async function fillPlanWeekend(d: LearningDeps, learner: LearnerContext, runId: string) {
  let run = await getRun(d, learner, runId);
  for (const [stepId, answers] of Object.entries(planWeekendAnswers)) run = await saveAnswers(d, learner, runId, { stepId, answers, rev: run.rev });
  return run;
}

describe('reveals survive abandoning a run', () => {
  it('starts the retry with the revealed answers as given, locked, and graded as given', async () => {
    const d = deps();
    const first = await startMission(d, alice, 'spot-the-ai-mistake', 'web');
    let run = await saveAnswers(d, alice, first.id, { stepId: 'predict', answers: { choice: 'opt-more-right', confidence: 80 }, rev: 0 });
    run = (await revealAnswer(d, alice, first.id, { stepId: 'predict', itemId: 'prediction' })).run;
    run = await saveAnswers(d, alice, first.id, { stepId: 'source-quiz', answers: { 'q-link': 'trust', 'q-best-source': 'official' }, rev: run.rev });
    await revealAnswer(d, alice, first.id, { stepId: 'source-quiz', itemId: 'q-link' });
    await abandonRun(d, alice, first.id);

    tick();
    const retry = await openMission(deps(), alice, 'spot-the-ai-mistake', 'web');
    expect(retry.id).not.toBe(first.id);
    expect(retry).toMatchObject({
      status: 'started', rev: 0, hintsUsed: 0,
      revealed: ['predict:prediction', 'source-quiz:q-link'],
      // Only the locked fields come along; the unrevealed q-best-source starts empty again.
      answers: { predict: { choice: 'opt-more-right', confidence: 80 }, 'source-quiz': { 'q-link': 'trust' } },
    });
    // The keys of the carried reveals are visible, as they were before abandoning.
    expect(Object.keys((await getRunWithEvaluation(deps(), alice, retry.id)).answerKey).sort()).toEqual(['predict:prediction', 'source-quiz:q-link']);

    // Correcting a carried answer is refused, by autosave and by an MCP submit with answers.
    const lockedErr = { code: 'forbidden' };
    await expect(saveAnswers(deps(), alice, retry.id, { stepId: 'source-quiz', answers: { 'q-link': 'open-read' }, rev: 0 })).rejects.toMatchObject(lockedErr);
    await expect(saveAnswers(deps(), alice, retry.id, { stepId: 'predict', answers: { choice: 'opt-no-signal', confidence: 80 }, rev: 0 }))
      .rejects.toMatchObject(lockedErr);
    await expect(submitEvidence(deps(), alice, retry.id, {
      idempotencyKey: 'key-00000001', answers: { predict: { choice: 'opt-no-signal', confidence: 80 } }, source: 'mcp',
    })).rejects.toMatchObject(lockedErr);
    // Other answers stay editable.
    const edited = await saveAnswers(deps(), alice, retry.id, { stepId: 'source-quiz', answers: { 'q-link': 'trust', 'q-best-source': 'official' }, rev: 0 });

    // Grading sees the original (wrong) prediction, exactly as if the learner had not abandoned.
    const mission = getMission('spot-the-ai-mistake')!;
    const confidence = deterministicResults(mission, edited.answers).find((c) => c.id === 'confidence-signal');
    expect(confidence?.score).toBe(0);
  });

  it('keeps carrying across several abandons and only within the learner\'s own runs', async () => {
    const first = await startMission(deps(), alice, 'spot-the-ai-mistake', 'web');
    await saveAnswers(deps(), alice, first.id, { stepId: 'source-quiz', answers: { 'q-link': 'trust' }, rev: 0 });
    await revealAnswer(deps(), alice, first.id, { stepId: 'source-quiz', itemId: 'q-link' });
    await abandonRun(deps(), alice, first.id);

    tick();
    const second = await startMission(deps(), alice, 'spot-the-ai-mistake', 'web');
    await abandonRun(deps(), alice, second.id);
    tick();
    const third = await startMission(deps(), alice, 'spot-the-ai-mistake', 'web');
    expect(third).toMatchObject({ revealed: ['source-quiz:q-link'], answers: { 'source-quiz': { 'q-link': 'trust' } } });

    // Another learner, and another mission of the same learner, start clean.
    expect(await startMission(deps(), bob, 'spot-the-ai-mistake', 'web')).toMatchObject({ revealed: [], answers: {} });
    expect(await startMission(deps(), alice, 'plan-weekend', 'web')).toMatchObject({ revealed: [], answers: {} });
  });

  it('skips a stored reveal that the current content cannot lock', async () => {
    const run = await startMission(deps(), alice, 'spot-the-ai-mistake', 'web');
    // Rows written under older content: an unknown step, a non-revealable claim, an option that no longer exists.
    await env.DB.prepare(`UPDATE mission_runs SET status = 'abandoned', revealed_json = ?, answers_json = ? WHERE id = ?`).bind(
      JSON.stringify(['gone:q', 'sample-check:claim-lemon', 'source-quiz:q-link', 'source-quiz:q-best-source', 'bad']),
      JSON.stringify({ 'source-quiz': { 'q-link': 'removed-option', 'q-best-source': 'official' }, 'sample-check': { 'claim-lemon': 'verified' } }),
      run.id,
    ).run();
    const carried = await carriedReveals(env.DB, alice.id, getMission('spot-the-ai-mistake')!);
    expect(carried).toEqual({ revealed: ['source-quiz:q-best-source'], answers: { 'source-quiz': { 'q-best-source': 'official' } } });
  });
});

describe('hints survive abandoning a run', () => {
  it('a pass after abandoning a hinted run earns no no-hint bonus or badge', async () => {
    const { fetchImpl } = openRouterFetch((b) => gradeAll(b, 0.9));
    const first = await startMission(deps({ fetchImpl }), alice, 'plan-weekend', 'web');
    await requestHint(deps({ fetchImpl }), alice, first.id, 'constraints', 1);
    await abandonRun(deps(), alice, first.id);

    tick();
    const retry = await startMission(deps(), alice, 'plan-weekend', 'web');
    expect(retry.hintsUsed).toBe(0); // the run's own counter stays truthful for analytics
    expect(await carriedHintsUsed(env.DB, alice.id, 'plan-weekend')).toBe(1);
    await fillPlanWeekend(deps(), alice, retry.id);
    const res = await submitEvidence(deps({ fetchImpl }), alice, retry.id, { idempotencyKey: 'key-00000001', confidence: 85, source: 'web' });
    expect(res.evaluation.status).toBe('passed');
    // 150 base + 30 calibration; the 30 no-hint bonus is gone (210 without the earlier hint).
    expect(res.rewards.xpGained).toBe(180);
    expect(res.rewards.newBadges.map((b) => b.id)).not.toContain('solo-pass');
    const granted = await env.DB.prepare(`SELECT props_json FROM events WHERE name = 'xp.granted'`).first<{ props_json: string }>();
    expect(JSON.parse(granted!.props_json)).toMatchObject({ noHintBonus: 0, amount: 180 });
  });

  it('a "Làm lại" after completing the mission starts a new attempt with nothing carried', async () => {
    const { fetchImpl } = openRouterFetch((b) => gradeAll(b, 0.9));
    const abandoned = await startMission(deps({ fetchImpl }), alice, 'spot-the-ai-mistake', 'web');
    await requestHint(deps({ fetchImpl }), alice, abandoned.id, 'predict', 1);
    await saveAnswers(deps(), alice, abandoned.id, { stepId: 'predict', answers: { choice: 'opt-more-right', confidence: 80 }, rev: 0 });
    await revealAnswer(deps(), alice, abandoned.id, { stepId: 'predict', itemId: 'prediction' });
    await abandonRun(deps(), alice, abandoned.id);

    tick();
    const passedRun = await startMission(deps(), alice, 'plan-weekend', 'web');
    await fillPlanWeekend(deps(), alice, passedRun.id);
    // Completion of another mission does not end this mission's attempt.
    await submitEvidence(deps({ fetchImpl }), alice, passedRun.id, { idempotencyKey: 'key-00000002', source: 'web' });
    expect(await carriedHintsUsed(env.DB, alice.id, 'spot-the-ai-mistake')).toBe(1);

    // Complete spot-the-ai-mistake itself (status forced: its own grading path is covered elsewhere).
    tick();
    const done = await startMission(deps(), alice, 'spot-the-ai-mistake', 'web');
    expect(done.revealed).toEqual(['predict:prediction']);
    await env.DB.prepare(`UPDATE mission_runs SET status = 'completed', completed_at = ? WHERE id = ?`)
      .bind(new Date(T0 + minute * 60_000).toISOString(), done.id).run();

    tick();
    const again = await startMission(deps(), alice, 'spot-the-ai-mistake', 'web');
    expect(again).toMatchObject({ revealed: [], answers: {} });
    expect(await carriedHintsUsed(env.DB, alice.id, 'spot-the-ai-mistake')).toBe(0);
  });
});
