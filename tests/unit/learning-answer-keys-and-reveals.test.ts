/** Answer keys never reach the browser before grading; quiz/prediction reveals are recorded and locked on the server. */
import type { APIContext, APIRoute } from 'astro';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPublishedMissions } from '../../src/lib/content/loader';
import { answerKeyForRun } from '../../src/lib/learning/answer-reveals';
import { learnerMissionView } from '../../src/lib/learning/learner-mission-view';
import {
  getRun, getRunWithEvaluation, revealAnswer, saveAnswers, startMission, submitEvidence, type LearningDeps,
} from '../../src/lib/learning/service';
import type { LearnerContext } from '../../src/lib/learning/types';
import { GET as getRunRoute } from '../../src/pages/api/v1/runs/[id]/index';
import { POST as revealRoute } from '../../src/pages/api/v1/runs/[id]/reveal';
import { POST as submitRoute } from '../../src/pages/api/v1/runs/[id]/submit';
import { fakeEnv, gradeAll, openRouterFetch, planWeekendAnswers, seedLearner, type FakeEnv } from './learning-fake-env';

const NOW = new Date('2026-10-26T03:00:00Z');
let env: FakeEnv;
let alice: LearnerContext;
let deps: LearningDeps;

function call(route: APIRoute, learner: LearnerContext, params: Record<string, string>, body?: unknown) {
  const url = new URL('https://unlock.zuey.me/api/v1/x');
  const init: RequestInit = body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
  const ctx = { request: new Request(url, init), url, params, locals: { learner, runtime: { env } } };
  return route(ctx as unknown as APIContext) as Promise<Response>;
}

/** Every answer-key string of a mission (verdict explanations, quiz/prediction explanations, hints, guidance). */
function secretTexts(m: ReturnType<typeof listPublishedMissions>[number]): string[] {
  const out: string[] = [];
  for (const s of m.steps) {
    out.push(...s.hints);
    if (s.type === 'verification') out.push(...s.claims.map((c) => c.explanation));
    if (s.type === 'quiz') out.push(...s.questions.map((q) => q.explanation));
    if (s.type === 'prediction') out.push(s.explanation);
  }
  for (const c of m.rubric.criteria) if (c.guidance) out.push(c.guidance);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  env = fakeEnv();
  alice = await seedLearner(env.DB, 'lrn_alice');
  deps = { env, now: () => NOW };
});

describe('learner mission view', () => {
  it('strips every key, explanation, hint and rubric check of every published mission', () => {
    for (const m of listPublishedMissions()) {
      const json = JSON.stringify(learnerMissionView(m));
      // ("explanation" is also a legitimate answer field id in one mission, so explanations are checked by text.)
      for (const field of ['"correct"', '"answer"', '"hints"', '"check"', '"guidance"', '"step_refs"']) {
        expect(json, `${m.id} ${field}`).not.toContain(field);
      }
      for (const text of secretTexts(m)) expect(json, m.id).not.toContain(JSON.stringify(text).slice(1, -1));
    }
  });

  it('GET /runs/:id serves the stripped view and no key before grading', async () => {
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    const res = await call(getRunRoute, alice, { id: run.id });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('"explanation"');
    expect(text).not.toContain('"hints"');
    expect(JSON.parse(text).answerKey).toEqual({});
  });

  it('returns claim keys only once the run is completed', async () => {
    const { fetchImpl } = openRouterFetch((b) => gradeAll(b, 0.9));
    const d = { ...deps, fetchImpl };
    const run = await startMission(d, alice, 'plan-weekend', 'web');
    let current = await getRun(d, alice, run.id);
    for (const [stepId, answers] of Object.entries(planWeekendAnswers)) current = await saveAnswers(d, alice, run.id, { stepId, answers, rev: current.rev });
    expect((await getRunWithEvaluation(d, alice, run.id)).answerKey).toEqual({});
    // The route builds its deps from the env, so the grader's fetch is stubbed globally.
    vi.stubGlobal('fetch', fetchImpl);
    const res = await call(submitRoute, alice, { id: run.id }, { idempotencyKey: 'key-00000001' });
    const body = await res.json() as { run: { status: string }; answerKey: Record<string, { correct: string[] }> };
    expect(body.run.status).toBe('completed');
    expect(body.answerKey['verify:claim-hours'].correct).toEqual(['needs_lookup']);
    expect(Object.keys((await getRunWithEvaluation(d, alice, run.id)).answerKey)).toContain('verify:claim-weather');
  });
});

describe('server-recorded reveals (spot-the-ai-mistake)', () => {
  it('reveals one quiz question after its answer is saved, then locks that answer only', async () => {
    const run = await startMission(deps, alice, 'spot-the-ai-mistake', 'web');
    await expect(revealAnswer(deps, alice, run.id, { stepId: 'source-quiz', itemId: 'q-link' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(revealAnswer(deps, alice, run.id, { stepId: 'sample-check', itemId: 'claim-lemon' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(revealAnswer(deps, alice, run.id, { stepId: 'source-quiz', itemId: 'nope' })).rejects.toMatchObject({ code: 'invalid' });

    const saved = await saveAnswers(deps, alice, run.id, { stepId: 'source-quiz', answers: { 'q-link': 'trust' }, rev: 0 });
    const res = await call(revealRoute, alice, { id: run.id }, { stepId: 'source-quiz', itemId: 'q-link' });
    expect(res.status).toBe(200);
    const body = await res.json() as { run: { rev: number; revealed: string[] }; key: { correct: string[]; explanation: string } };
    expect(body.key.correct).toEqual(['open-read']);
    expect(body.key.explanation).toBeTruthy();
    expect(body.run).toMatchObject({ rev: saved.rev + 1, revealed: ['source-quiz:q-link'] });
    // Idempotent, no extra rev bump.
    expect((await revealAnswer(deps, alice, run.id, { stepId: 'source-quiz', itemId: 'q-link' })).run.rev).toBe(body.run.rev);

    const detail = await getRunWithEvaluation(deps, alice, run.id);
    expect(Object.keys(detail.answerKey)).toEqual(['source-quiz:q-link']);

    // Changing the revealed answer is refused; another question of the step stays editable.
    const rev = body.run.rev;
    await expect(saveAnswers(deps, alice, run.id, { stepId: 'source-quiz', answers: { 'q-link': 'open-read' }, rev })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(saveAnswers(deps, alice, run.id, { stepId: 'source-quiz', answers: {}, rev })).rejects.toMatchObject({ code: 'forbidden' });
    const ok = await saveAnswers(deps, alice, run.id, { stepId: 'source-quiz', answers: { 'q-link': 'trust', 'q-best-source': 'official' }, rev });
    expect(ok.answers['source-quiz']).toEqual({ 'q-link': 'trust', 'q-best-source': 'official' });
    // Submitting changed answers (MCP path) is refused as well.
    await expect(submitEvidence(deps, alice, run.id, {
      idempotencyKey: 'key-00000001', answers: { 'source-quiz': { 'q-link': 'open-read', 'q-best-source': 'official' } }, source: 'mcp',
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('locks the prediction choice and its confidence after the reveal', async () => {
    const run = await startMission(deps, alice, 'spot-the-ai-mistake', 'web');
    const saved = await saveAnswers(deps, alice, run.id, { stepId: 'predict', answers: { choice: 'opt-more-right', confidence: 70 }, rev: 0 });
    const { run: after, key } = await revealAnswer(deps, alice, run.id, { stepId: 'predict', itemId: 'prediction' });
    expect(key.correct).toEqual(['opt-no-signal']);
    expect(after.rev).toBe(saved.rev + 1);
    for (const answers of [{ choice: 'opt-no-signal', confidence: 70 }, { choice: 'opt-more-right', confidence: 20 }]) {
      await expect(saveAnswers(deps, alice, run.id, { stepId: 'predict', answers, rev: after.rev })).rejects.toMatchObject({ code: 'forbidden' });
    }
    // Other steps stay editable; another learner's or an unknown run is not_found.
    await saveAnswers(deps, alice, run.id, { stepId: 'source-quiz', answers: { 'q-link': 'trust' }, rev: after.rev });
    await expect(revealAnswer(deps, alice, 'run_unknown', { stepId: 'predict', itemId: 'prediction' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answerKeyForRun ignores unknown or non-revealable items and returns everything once completed', () => {
    const m = listPublishedMissions().find((x) => x.id === 'spot-the-ai-mistake')!;
    expect(answerKeyForRun(m, { status: 'started', revealed: ['sample-check:claim-lemon', 'x:y', 'bad'] })).toEqual({});
    const all = answerKeyForRun(m, { status: 'completed', revealed: [] });
    expect(Object.keys(all)).toEqual(expect.arrayContaining(['predict:prediction', 'source-quiz:q-link', 'sample-check:claim-lemon']));
  });
});
