import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCallError, workersAiChat } from '../../src/lib/coach/ai-clients';
import { AiUnavailableError, runAi, type AiRequest } from '../../src/lib/coach/ai-gateway';
import { estimateCostUsd, WORKERS_AI_DAILY_REQUESTS_PER_LEARNER, WORKERS_AI_MODEL } from '../../src/lib/coach/ai-models';
import { budgetLimits, GLOBAL_USAGE_ID, readUsage, reserveUsd } from '../../src/lib/coach/ai-usage';
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

/** D1 serializes statements; the node:sqlite helper cannot overlap two batch transactions, so queue them. */
function serializedBatches(db: D1Database): D1Database {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    batch: (stmts: D1PreparedStatement[]) => {
      const next = chain.then(() => db.batch(stmts));
      chain = next.catch(() => undefined);
      return next;
    },
  } as unknown as D1Database;
}

describe('global caps and concurrent reservations', () => {
  it('stops Workers AI for everyone once the global daily cap is spent', async () => {
    const capped = fakeEnv({ OPENROUTER_API_KEY: undefined, AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL: '3' });
    capped.AI.run.mockResolvedValue({ response: 'ok' });
    for (const learnerId of ['lrn_a', 'lrn_b', 'lrn_c']) {
      expect((await runAi({ env: capped, now: () => NOW }, req({ learnerId, purpose: 'grade' }))).provider).toBe('workers-ai');
    }
    const err = await runAi({ env: capped, now: () => NOW }, req({ learnerId: 'lrn_fresh', purpose: 'grade' })).catch((e) => e);
    expect(err).toMatchObject({ reason: 'budget' });
    expect(capped.AI.run).toHaveBeenCalledTimes(3);
    expect((await readUsage(capped.DB, DAY, 'lrn_fresh')).global.workersAiRequests).toBe(3);
    const ev = await capped.DB.prepare(`SELECT props_json FROM events WHERE name = 'ai.budget_exceeded'`).first<{ props_json: string }>();
    expect(JSON.parse(ev!.props_json)).toEqual({ purpose: 'grade', scope: 'workers_ai_global' });
  });

  it('defaults the global Workers AI cap when the var is missing or malformed', () => {
    expect(budgetLimits({ AI_DAILY_BUDGET_USD_PER_LEARNER: '', AI_DAILY_BUDGET_USD_GLOBAL: '' }).workersAiGlobal).toBeGreaterThan(0);
    expect(budgetLimits({ AI_DAILY_BUDGET_USD_PER_LEARNER: '', AI_DAILY_BUDGET_USD_GLOBAL: '', AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL: 'x' }).workersAiGlobal)
      .toBe(budgetLimits({ AI_DAILY_BUDGET_USD_PER_LEARNER: '', AI_DAILY_BUDGET_USD_GLOBAL: '' }).workersAiGlobal);
  });

  it('concurrent calls cannot overshoot the USD budget: each reserves its worst case first', async () => {
    const tight = fakeEnv({ AI_DAILY_BUDGET_USD_PER_LEARNER: '0.01' });
    tight.DB = serializedBatches(tight.DB);
    tight.AI.run.mockResolvedValue({ response: 'fallback' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return Response.json({ model: 'google/gemini-3.1-flash-lite', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    }) as unknown as typeof fetch;
    // Worst case per call: 2000 output tokens × $1.5/M = $0.003, so only 3 fit in $0.01.
    // Grading may use the learner's full cap (coaching would stop at its share).
    const calls = Array.from({ length: 10 }, () =>
      runAi({ env: tight, fetchImpl, now: () => NOW }, req({ maxTokens: 2000, purpose: 'grade' })));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.provider === 'openrouter')).toHaveLength(3);
    expect(results.filter((r) => r.provider === 'workers-ai')).toHaveLength(7);
    const usage = await readUsage(tight.DB, DAY, 'lrn_a');
    expect(usage.learner.reservedUsd).toBeCloseTo(0, 9);
    expect(usage.global.reservedUsd).toBeCloseTo(0, 9);
    expect(usage.learner.costUsd).toBeCloseTo(estimateCostUsd('google/gemini-3.1-flash-lite', 10, 10) * 3, 9);
  });

  it('releases the reservation when the OpenRouter call fails', async () => {
    env.AI.run.mockResolvedValue({ response: 'fallback' });
    await runAi({ env, fetchImpl: failingFetch(), now: () => NOW }, req());
    const usage = await readUsage(env.DB, DAY, 'lrn_a');
    expect(usage.learner.reservedUsd).toBe(0);
    expect(usage.global.reservedUsd).toBe(0);
  });

  it('reserves on both rows or on neither', async () => {
    const limits = { ...budgetLimits(env), perLearnerUsd: 1, globalUsd: 1 };
    await setUsage(GLOBAL_USAGE_ID, 0.9);
    expect(await reserveUsd(env.DB, DAY, 'lrn_a', 0.2, limits, 'grading')).toBe(false);
    expect(await readUsage(env.DB, DAY, 'lrn_a')).toMatchObject({ learner: { reservedUsd: 0 }, global: { reservedUsd: 0 } });
    expect(await reserveUsd(env.DB, DAY, 'lrn_a', 0.1, limits, 'grading')).toBe(true);
    expect(await readUsage(env.DB, DAY, 'lrn_a')).toMatchObject({ learner: { reservedUsd: 0.1 }, global: { reservedUsd: 0.1 } });
  });

  it('evaluates the cap check once per statement, so updating the first row cannot skip the second', async () => {
    // 0.2 fits under 0.25 before the update but would not after it; both rows must still move together.
    const limits = { ...budgetLimits(env), perLearnerUsd: 0.25, globalUsd: 5 };
    expect(await reserveUsd(env.DB, DAY, 'lrn_b', 0.2, limits, 'grading')).toBe(true);
    expect(await readUsage(env.DB, DAY, 'lrn_b')).toMatchObject({ learner: { reservedUsd: 0.2 }, global: { reservedUsd: 0.2 } });
    expect(await reserveUsd(env.DB, DAY, 'lrn_b', 0.2, limits, 'grading')).toBe(false);
  });
});

describe('Workers AI timeout', () => {
  it('gives up on a call that never answers', async () => {
    const ai = { run: vi.fn(() => new Promise(() => undefined)) } as unknown as Ai;
    const err = await workersAiChat(ai, WORKERS_AI_MODEL, [{ role: 'user', content: 'hi' }], 10, 20).catch((e) => e);
    expect(err).toBeInstanceOf(AiCallError);
    expect(String(err.message)).toMatch(/timed out/);
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
