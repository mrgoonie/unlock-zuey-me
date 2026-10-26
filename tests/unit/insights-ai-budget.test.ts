/**
 * ai-tutor budget isolation: the 'insights' purpose reserves in the coaching pool of the global caps on its
 * own system row (never the learner's own coaching share), a spent global coaching share refuses insights
 * (deferred without spending an attempt, stage stops) while grading still runs, and a learner at the daily
 * analysis cap is deferred to the next UTC day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { budgetPool, INSIGHTS_USAGE_ID, runAi } from '../../src/lib/coach/ai-gateway';
import { WORKERS_AI_MODEL } from '../../src/lib/coach/ai-models';
import { budgetLimits, GLOBAL_USAGE_ID, readUsage } from '../../src/lib/coach/ai-usage';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { runAnalyzerStage } from '../../src/lib/insights/analyzer-stage';
import { analysesToday, nextUtcDayRetryAt } from '../../src/lib/insights/insights-quotas';
import { fakeEnv, openRouterFetch, type FakeEnv } from './learning-fake-env';

const NOW = new Date('2026-10-26T16:00:00.000Z');
const DAY = '2026-10-26';
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
let env: FakeEnv;

const validReport = () => JSON.stringify({
  relevant: true, intent_summary: { text: 'Bạn nhờ AI tóm tắt tài liệu.', confidence: 0.8 }, workflow_observed: [], learning_insights: [],
  verification_gaps: [], risk_signals: [], next_best_action: null, product_observation: null, confidence: 0.6,
});

async function setup(overrides: Partial<Env> = {}) {
  env = fakeEnv(overrides);
  await env.DB.prepare(`INSERT INTO learners (id, kind, profile_json, created_at, updated_at) VALUES ('lrn_a', 'member', '{}', ?, ?)`).bind(at(-9999), at(-9999)).run();
  await env.DB.prepare(`INSERT INTO insight_consents (learner_id, analysis, updated_at) VALUES ('lrn_a', 1, ?)`).bind(at(-9999)).run();
  const payload = JSON.stringify({ turn: { userPrompt: 'Tóm tắt giúp mình tài liệu này trong 5 ý', assistantFinal: 'Đây là 5 ý chính của tài liệu, kèm trích dẫn trang để bạn tự kiểm tra lại.', tools: [] } });
  await env.DB.prepare(`INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json, payload_bytes,
      status, attempts, next_attempt_at, turn_ended_at, received_at)
    VALUES ('iev_1', 'lrn_a', 'k1', 's1', 'claude-code', '0.1.0', ?, ?, 'pending', 0, ?, ?, ?)`).bind(payload, payload.length, at(-5), at(-10), at(-10)).run();
}

const eventRow = () => env.DB.prepare(`SELECT status, attempts, next_attempt_at FROM insight_events WHERE id = 'iev_1'`).first();

beforeEach(async () => {
  await setup();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('insights budget pool', () => {
  it('maps the insights purpose to the coaching pool', () => {
    expect(budgetPool('insights')).toBe('coaching');
    expect(budgetPool('grade')).toBe('grading');
  });

  it('reserves in the coaching columns of the insights system row during the call and settles there afterwards', async () => {
    const { fetchImpl } = openRouterFetch(() => validReport());
    // Read the reservation while the OpenRouter call is in flight.
    const spy = vi.fn();
    const wrapped = (async (url: string, init?: RequestInit) => {
      spy((await readUsage(env.DB, DAY, INSIGHTS_USAGE_ID)).learner.coachReservedUsd);
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const result = await runAnalyzerStage(env, createCronBudget(), NOW, { fetchImpl: wrapped });
    expect(result.analysed).toBe(1);
    expect(spy.mock.calls[0][0]).toBeGreaterThan(0);
    const after = await readUsage(env.DB, DAY, INSIGHTS_USAGE_ID);
    expect(after.learner.coachCostUsd).toBeGreaterThan(0);
    expect(after.learner.coachCostUsd).toBeCloseTo(after.learner.costUsd, 9);
    expect(after.global.coachCostUsd).toBeCloseTo(after.learner.coachCostUsd, 9);
    expect(after.global.coachReservedUsd).toBeCloseTo(0, 9);
  });

  it('never draws from the learner\'s own coaching share: a learner with it spent is still analysed, and their hints are untouched', async () => {
    const limits = budgetLimits(env);
    // lrn_a spent their whole per-learner coaching share on hints and chat today.
    await env.DB.prepare(`INSERT INTO ai_usage (day, learner_id, requests, cost_usd, coach_cost_usd, workers_ai_requests, coach_workers_ai_requests)
      VALUES (?, 'lrn_a', 1, ?, ?, ?, ?)`).bind(DAY, limits.coachPerLearnerUsd, limits.coachPerLearnerUsd, limits.coachWorkersAiPerLearner, limits.coachWorkersAiPerLearner).run();
    const before = await readUsage(env.DB, DAY, 'lrn_a');
    const { fetchImpl } = openRouterFetch(() => validReport());
    expect(await runAnalyzerStage(env, createCronBudget(), NOW, { fetchImpl })).toMatchObject({ analysed: 1, deferred: 0 });
    expect((await readUsage(env.DB, DAY, 'lrn_a')).learner).toEqual(before.learner);

    // Many analyses on the system row never reduce a fresh learner's hint budget.
    for (let i = 0; i < 20; i++) {
      await runAi({ env, fetchImpl, now: () => NOW }, {
        purpose: 'insights', learnerId: 'lrn_b', messages: [{ role: 'user', content: 'phân tích' }], maxTokens: 100, temperature: 0,
        openRouterModels: ['google/gemini-3.1-flash-lite'], workersAiModel: WORKERS_AI_MODEL, parse: (t) => t, timeoutMs: 1000,
      });
    }
    expect((await readUsage(env.DB, DAY, 'lrn_b')).learner.coachCostUsd).toBe(0);
    const hint = await runAi({ env, fetchImpl, now: () => NOW }, {
      purpose: 'hint', learnerId: 'lrn_b', messages: [{ role: 'user', content: 'gợi ý' }], maxTokens: 100, temperature: 0,
      openRouterModels: ['google/gemini-3.1-flash-lite'], workersAiModel: WORKERS_AI_MODEL, parse: (t) => t, timeoutMs: 1000,
    });
    expect(hint.provider).toBe('openrouter');
  });

  it('with the coaching share spent: insights is deferred (attempt kept) and the stage stops, while grading still passes', async () => {
    const limits = budgetLimits(env);
    // Coaching USD and coaching Workers AI shares spent globally; plenty of room left for grading.
    await env.DB.prepare(`INSERT INTO ai_usage (day, learner_id, requests, cost_usd, coach_cost_usd, workers_ai_requests, coach_workers_ai_requests)
      VALUES (?, ?, 1, ?, ?, ?, ?)`).bind(DAY, GLOBAL_USAGE_ID, limits.coachGlobalUsd, limits.coachGlobalUsd, limits.coachWorkersAiGlobal, limits.coachWorkersAiGlobal).run();
    const { fetchImpl } = openRouterFetch(() => validReport());

    const result = await runAnalyzerStage(env, createCronBudget(), NOW, { fetchImpl });
    expect(result).toMatchObject({ deferred: 1, failed: 0, analysed: 0, stopped: 'ai_budget' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(await eventRow()).toEqual({ status: 'pending', attempts: 0, next_attempt_at: at(15) });

    const graded = await runAi({ env, fetchImpl, now: () => NOW }, {
      purpose: 'grade', learnerId: 'lrn_b', messages: [{ role: 'user', content: 'chấm bài' }], maxTokens: 100, temperature: 0,
      openRouterModels: ['google/gemini-3.1-flash-lite'], workersAiModel: WORKERS_AI_MODEL, parse: (t) => t, timeoutMs: 1000,
    });
    expect(graded.provider).toBe('openrouter');
  });

  it('with the learner at 12 analyses today: deferred to 00:05 UTC next day without a model call', async () => {
    for (let i = 0; i < 12; i++) {
      await env.DB.prepare(`INSERT INTO insight_reports (id, learner_id, session_ref, report_json, intent_summary, confidence, source_runtime, model,
          prompt_version, event_count, window_started_at, window_ended_at, created_at, expires_at)
        VALUES (?, 'lrn_a', ?, '{}', 'x', 0.5, 'claude-code', 'm', 1, 1, ?, ?, ?, ?)`).bind(`irp_${i}`, `old_${i}`, at(-600), at(-600), at(-600 + i), at(99999)).run();
    }
    expect(await analysesToday(env.DB, 'lrn_a', NOW)).toBe(12);
    const { fetchImpl } = openRouterFetch(() => validReport());
    expect(await runAnalyzerStage(env, createCronBudget(), NOW, { fetchImpl })).toMatchObject({ deferred: 1, aiCalls: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(nextUtcDayRetryAt(NOW).toISOString()).toBe('2026-10-27T00:05:00.000Z');
    expect(await eventRow()).toEqual({ status: 'pending', attempts: 0, next_attempt_at: '2026-10-27T00:05:00.000Z' });
  });

  it('honours a lower INSIGHTS_DAILY_ANALYSES_PER_LEARNER and counts not_learning windows as analyses', async () => {
    await setup({ INSIGHTS_DAILY_ANALYSES_PER_LEARNER: '1' });
    await env.DB.prepare(`INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json, payload_bytes,
        status, skip_reason, attempts, next_attempt_at, turn_ended_at, received_at, processed_at)
      VALUES ('iev_old', 'lrn_a', 'k0', 's0', 'claude-code', '0.1.0', NULL, 10, 'skipped', 'not_learning', 1, ?, ?, ?, ?)`)
      .bind(at(-100), at(-100), at(-100), at(-90)).run();
    const { fetchImpl } = openRouterFetch(() => validReport());
    expect(await runAnalyzerStage(env, createCronBudget(), NOW, { fetchImpl })).toMatchObject({ deferred: 1, aiCalls: 0 });
  });
});
