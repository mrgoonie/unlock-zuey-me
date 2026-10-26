import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUnavailableError, runAi, type AiRequest } from '../../src/lib/coach/ai-gateway';
import { estimateCostUsd, WORKERS_AI_DAILY_REQUESTS_PER_LEARNER, WORKERS_AI_MODEL } from '../../src/lib/coach/ai-models';
import { GLOBAL_USAGE_ID, readUsage } from '../../src/lib/coach/ai-usage';
import { allowRequest, RATE_LIMITS } from '../../src/lib/coach/rate-limit';
import { failingFetch, fakeEnv, fakeKv, openRouterFetch, type FakeEnv } from './learning-fake-env';

const NOW = new Date('2026-10-26T03:00:00Z');
const DAY = '2026-10-26';
let env: FakeEnv;

const req = (over: Partial<AiRequest<string>> = {}): AiRequest<string> => ({
  purpose: 'chat', learnerId: 'lrn_a', messages: [{ role: 'user', content: 'Xin chào' }], maxTokens: 100, temperature: 0.5,
  openRouterModels: ['google/gemini-3.1-flash-lite'], workersAiModel: WORKERS_AI_MODEL, parse: (t) => t, timeoutMs: 1000, ...over,
});

const setUsage = (learnerId: string, cost: number, workersAi = 0) =>
  env.DB.prepare('INSERT INTO ai_usage (day, learner_id, requests, cost_usd, workers_ai_requests) VALUES (?, ?, 1, ?, ?)')
    .bind(DAY, learnerId, cost, workersAi).run();

const events = async (name: string) =>
  (await env.DB.prepare('SELECT props_json FROM events WHERE name = ?').bind(name).all<{ props_json: string }>()).results.map((r) => JSON.parse(r.props_json));

beforeEach(() => {
  env = fakeEnv();
  env.AI.run.mockResolvedValue({ response: 'Chào bạn từ Workers AI', usage: { prompt_tokens: 10, completion_tokens: 5 } });
});

describe('AI gateway', () => {
  it('uses OpenRouter within budget and records estimated cost for learner and global rows', async () => {
    const { fetchImpl, calls } = openRouterFetch(() => 'Chào bạn', { prompt_tokens: 1_000_000, completion_tokens: 100_000 });
    const r = await runAi({ env, fetchImpl, now: () => NOW }, req());
    expect(r).toMatchObject({ value: 'Chào bạn', provider: 'openrouter', model: 'google/gemini-3.1-flash-lite' });
    expect(calls[0].headers.authorization).toBe('Bearer test-key');
    expect(calls[0].body.response_format).toBeUndefined();
    const usage = await readUsage(env.DB, DAY, 'lrn_a');
    expect(usage.learner.costUsd).toBeCloseTo(0.25 + 0.15, 6);
    expect(usage.global.costUsd).toBeCloseTo(0.4, 6);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('refuses OpenRouter when the learner is over budget and falls back to Workers AI', async () => {
    await setUsage('lrn_a', 0.31);
    const { fetchImpl } = openRouterFetch(() => 'nope');
    const r = await runAi({ env, fetchImpl, now: () => NOW }, req());
    expect(r).toMatchObject({ provider: 'workers-ai', value: 'Chào bạn từ Workers AI' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await events('ai.budget_exceeded')).toEqual([{ purpose: 'chat', scope: 'learner' }]);
    expect(await events('ai.fallback_used')).toEqual([{ purpose: 'chat', reason: 'budget', model: WORKERS_AI_MODEL }]);
    expect((await readUsage(env.DB, DAY, 'lrn_a')).learner.workersAiRequests).toBe(1);
  });

  it('refuses OpenRouter when the global budget is spent', async () => {
    await setUsage(GLOBAL_USAGE_ID, 5);
    const { fetchImpl } = openRouterFetch(() => 'nope');
    await runAi({ env, fetchImpl, now: () => NOW }, req());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await events('ai.budget_exceeded')).toEqual([{ purpose: 'chat', scope: 'global' }]);
  });

  it('tries the next OpenRouter model, then Workers AI, when calls or validation fail', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'invalid output' } }], usage: {} })) as unknown as typeof fetch;
    const parse = (t: string) => {
      if (t === 'invalid output') throw new Error('rejected');
      return t;
    };
    const r = await runAi({ env, fetchImpl, now: () => NOW }, req({ openRouterModels: ['m1', 'm2'], parse }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.provider).toBe('workers-ai');
    expect(await events('ai.fallback_used')).toEqual([{ purpose: 'chat', reason: 'openrouter_failed', model: WORKERS_AI_MODEL }]);
  });

  it('caps Workers AI per learner per day', async () => {
    await setUsage('lrn_a', 0.5, WORKERS_AI_DAILY_REQUESTS_PER_LEARNER);
    const err = await runAi({ env, fetchImpl: failingFetch(), now: () => NOW }, req()).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).reason).toBe('budget');
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('reports failure when every path fails', async () => {
    env.AI.run.mockRejectedValue(new Error('down'));
    const err = await runAi({ env, fetchImpl: failingFetch(), now: () => NOW }, req()).catch((e) => e);
    expect(err).toMatchObject({ reason: 'failed' });
  });

  it('without an API key goes straight to Workers AI', async () => {
    const noKey = fakeEnv({ OPENROUTER_API_KEY: undefined });
    (noKey.AI.run as ReturnType<typeof vi.fn>).mockResolvedValue({ response: 'ok' });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await runAi({ env: noKey, fetchImpl, now: () => NOW }, req())).provider).toBe('workers-ai');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('cost estimate and rate limit', () => {
  it('prices known, dated and unknown models', () => {
    expect(estimateCostUsd('anthropic/claude-sonnet-5.5', 1_000_000, 1_000_000)).toBe(12);
    expect(estimateCostUsd('anthropic/claude-sonnet-5.5-20261001', 1_000_000, 0)).toBe(2);
    expect(estimateCostUsd('mystery/model', 1_000_000, 0)).toBe(10);
  });
  it('allows N requests per minute window', async () => {
    const kv = fakeKv();
    for (let i = 0; i < RATE_LIMITS.chat; i++) expect(await allowRequest(kv, 'chat', 'lrn_a', NOW)).toBe(true);
    expect(await allowRequest(kv, 'chat', 'lrn_a', NOW)).toBe(false);
    expect(await allowRequest(kv, 'chat', 'lrn_b', NOW)).toBe(true);
    expect(await allowRequest(kv, 'chat', 'lrn_a', new Date(NOW.getTime() + 60_000))).toBe(true);
  });
});
