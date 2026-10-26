/**
 * Grading is protected from coaching traffic: practice chat and hints together may only use a share of the
 * global daily caps (AI_DAILY_COACH_SHARE, default 0.5), while grading may use the full caps.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AiUnavailableError, runAi, type AiRequest } from '../../src/lib/coach/ai-gateway';
import { DEFAULT_COACH_SHARE, WORKERS_AI_MODEL } from '../../src/lib/coach/ai-models';
import { budgetLimits, coachShare, GLOBAL_USAGE_ID, readUsage, releaseUsd, reserveUsd, reserveWorkersAiCall } from '../../src/lib/coach/ai-usage';
import { generateHint } from '../../src/lib/coach/hint-coach';
import { getMission } from '../../src/lib/content/loader';
import { sendPracticeChat } from '../../src/lib/learning/service';
import { fakeEnv, openRouterFetch, seedLearner, type FakeEnv } from './learning-fake-env';

const NOW = new Date('2026-10-26T03:00:00Z');
const DAY = '2026-10-26';
const FLASH = 'google/gemini-3.1-flash-lite';

const req = (over: Partial<AiRequest<string>> = {}): AiRequest<string> => ({
  purpose: 'chat', learnerId: 'lrn_a', messages: [{ role: 'user', content: 'Xin chào' }], maxTokens: 2000, temperature: 0.5,
  openRouterModels: [FLASH], workersAiModel: WORKERS_AI_MODEL, parse: (t) => t, timeoutMs: 1000, ...over,
});

const budgetEvents = async (env: FakeEnv) =>
  (await env.DB.prepare(`SELECT props_json FROM events WHERE name = 'ai.budget_exceeded'`).all<{ props_json: string }>())
    .results.map((r) => JSON.parse(r.props_json));

describe('coaching share of the global AI caps', () => {
  let env: FakeEnv;
  beforeEach(() => {
    // Worst case per call: 2000 output tokens × $1.5/M = $0.003. Coaching share: 0.5 × $0.01 = $0.005.
    env = fakeEnv({ AI_DAILY_BUDGET_USD_GLOBAL: '0.01', AI_DAILY_BUDGET_USD_PER_LEARNER: '1' });
    env.AI.run.mockResolvedValue({ response: 'Chào bạn từ Workers AI', usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });

  it('exhausting the coaching USD share leaves grading able to reserve OpenRouter', async () => {
    const { fetchImpl } = openRouterFetch(() => 'ok', { prompt_tokens: 0, completion_tokens: 2000 });
    expect((await runAi({ env, fetchImpl, now: () => NOW }, req())).provider).toBe('openrouter');
    // The second chat would push coaching spend to $0.006 > $0.005: refused on OpenRouter, Workers AI answers.
    expect((await runAi({ env, fetchImpl, now: () => NOW }, req({ learnerId: 'lrn_b' }))).provider).toBe('workers-ai');
    expect(await budgetEvents(env)).toEqual([{ purpose: 'chat', scope: 'coach_share' }]);
    // A hint draws from the same share.
    expect((await runAi({ env, fetchImpl, now: () => NOW }, req({ purpose: 'hint', learnerId: 'lrn_c' }))).provider).toBe('workers-ai');

    const graded = await runAi({ env, fetchImpl, now: () => NOW }, req({ purpose: 'grade', learnerId: 'lrn_d' }));
    expect(graded.provider).toBe('openrouter');
    const { global } = await readUsage(env.DB, DAY, 'lrn_d');
    expect(global.coachCostUsd).toBeLessThanOrEqual(0.005);
    expect(global.costUsd).toBeGreaterThan(global.coachCostUsd);
    expect(global.reservedUsd).toBeCloseTo(0, 9);
    expect(global.coachReservedUsd).toBeCloseTo(0, 9);
  });

  it('exhausting the coaching Workers AI share gives chat a budget error while grading still runs', async () => {
    const capped = fakeEnv({ OPENROUTER_API_KEY: undefined, AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL: '4' });
    capped.AI.run.mockResolvedValue({ response: 'ok' });
    for (const learnerId of ['lrn_a', 'lrn_b']) {
      expect((await runAi({ env: capped, now: () => NOW }, req({ learnerId }))).provider).toBe('workers-ai');
    }
    const err = await runAi({ env: capped, now: () => NOW }, req({ learnerId: 'lrn_c' })).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err).toMatchObject({ reason: 'budget' });
    expect(await budgetEvents(capped)).toEqual([{ purpose: 'chat', scope: 'workers_ai_coach_share' }]);

    for (const learnerId of ['lrn_c', 'lrn_d']) {
      expect((await runAi({ env: capped, now: () => NOW }, req({ learnerId, purpose: 'grade' }))).provider).toBe('workers-ai');
    }
    // The full global cap (4) is now spent, so grading stops too.
    expect(await runAi({ env: capped, now: () => NOW }, req({ learnerId: 'lrn_e', purpose: 'grade' })).catch((e) => e))
      .toMatchObject({ reason: 'budget' });
    const { global } = await readUsage(capped.DB, DAY, 'lrn_e');
    expect(global).toMatchObject({ workersAiRequests: 4, coachWorkersAiRequests: 2 });
  });

  it('practice chat shows the friendly out-of-turns message once the coaching share is spent', async () => {
    const alice = await seedLearner(env.DB, 'lrn_alice');
    await env.DB.prepare(
      'INSERT INTO ai_usage (day, learner_id, cost_usd, coach_cost_usd, workers_ai_requests, coach_workers_ai_requests) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(DAY, GLOBAL_USAGE_ID, 0.005, 0.005, 1000, 1000).run();
    const { fetchImpl } = openRouterFetch(() => 'ok');
    const err = await sendPracticeChat({ env, fetchImpl, now: () => NOW }, alice, { messages: [{ role: 'user', content: 'Chào bạn' }] })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'budget_exceeded' });
    expect(String(err.message)).toMatch(/hết lượt/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('hints fall back to the authored static hint once the coaching share is spent', async () => {
    const mission = getMission('plan-weekend')!;
    const step = mission.steps[0];
    await env.DB.prepare(
      'INSERT INTO ai_usage (day, learner_id, cost_usd, coach_cost_usd, workers_ai_requests, coach_workers_ai_requests) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(DAY, GLOBAL_USAGE_ID, 0.005, 0.005, 1000, 1000).run();
    const { fetchImpl } = openRouterFetch(() => 'AI hint');
    const hint = await generateHint({ env, fetchImpl, now: () => NOW }, {
      learnerId: 'lrn_a', runId: 'run_1', mission, step, level: 1, stepAnswers: undefined,
    });
    expect(hint).toMatchObject({ origin: 'static', text: step.hints[0], model: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('grading reservations do not count toward the coaching share, but coaching counts toward the total', async () => {
    const limits = { ...budgetLimits(env), perLearnerUsd: 10, globalUsd: 1, coachGlobalUsd: 0.5 };
    expect(await reserveUsd(env.DB, DAY, 'lrn_a', 0.6, limits, 'grading')).toBe(true);
    expect(await reserveUsd(env.DB, DAY, 'lrn_a', 0.4, limits, 'coaching')).toBe(true);
    expect(await reserveUsd(env.DB, DAY, 'lrn_a', 0.01, limits, 'coaching')).toBe(false);
    expect(await reserveUsd(env.DB, DAY, 'lrn_a', 0.01, limits, 'grading')).toBe(false);
    expect((await readUsage(env.DB, DAY, 'lrn_a')).global).toMatchObject({ reservedUsd: 1, coachReservedUsd: 0.4 });

    await releaseUsd(env.DB, DAY, 'lrn_a', 0.4, 'coaching');
    expect((await readUsage(env.DB, DAY, 'lrn_a')).global).toMatchObject({ reservedUsd: 0.6, coachReservedUsd: 0 });
    expect(await reserveUsd(env.DB, DAY, 'lrn_a', 0.5, limits, 'coaching')).toBe(false); // within the share, but 0.6 + 0.5 passes the total
    expect(await reserveUsd(env.DB, DAY, 'lrn_a', 0.4, limits, 'coaching')).toBe(true);
  });

  it('caps coaching Workers AI calls at the share of the global request cap', async () => {
    const limits = { ...budgetLimits(env), workersAiPerLearner: 100, workersAiGlobal: 3, coachWorkersAiGlobal: 1 };
    expect(await reserveWorkersAiCall(env.DB, DAY, 'lrn_a', limits, 'coaching')).toBe(true);
    expect(await reserveWorkersAiCall(env.DB, DAY, 'lrn_b', limits, 'coaching')).toBe(false);
    expect(await reserveWorkersAiCall(env.DB, DAY, 'lrn_b', limits, 'grading')).toBe(true);
    expect(await reserveWorkersAiCall(env.DB, DAY, 'lrn_b', limits, 'grading')).toBe(true);
    expect(await reserveWorkersAiCall(env.DB, DAY, 'lrn_b', limits, 'grading')).toBe(false);
    expect((await readUsage(env.DB, DAY, 'lrn_b')).learner).toMatchObject({ workersAiRequests: 2, coachWorkersAiRequests: 0 });
  });

  it('reads the share from AI_DAILY_COACH_SHARE, defaulting when missing or out of range', () => {
    expect(coachShare(undefined)).toBe(DEFAULT_COACH_SHARE);
    expect(DEFAULT_COACH_SHARE).toBe(0.5);
    expect(coachShare('x')).toBe(DEFAULT_COACH_SHARE);
    expect(coachShare('-0.2')).toBe(DEFAULT_COACH_SHARE);
    expect(coachShare('1.5')).toBe(DEFAULT_COACH_SHARE);
    expect(coachShare('0.25')).toBe(0.25);
    expect(coachShare('1')).toBe(1);
    const limits = budgetLimits({
      AI_DAILY_BUDGET_USD_PER_LEARNER: '0.3', AI_DAILY_BUDGET_USD_GLOBAL: '5', AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL: '2001', AI_DAILY_COACH_SHARE: '0.5',
    });
    expect(limits).toMatchObject({ coachGlobalUsd: 2.5, coachWorkersAiGlobal: 1000, globalUsd: 5, workersAiGlobal: 2001 });
  });
});
