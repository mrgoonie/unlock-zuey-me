import { beforeEach, describe, expect, it } from 'vitest';
import { PRACTICE_LIMITS } from '../../src/lib/coach/practice-chat';
import { getMission } from '../../src/lib/content/loader';
import { getRun, requestHint, sendPracticeChat, startMission } from '../../src/lib/learning/service';
import type { LearnerContext } from '../../src/lib/learning/types';
import { failingFetch, fakeEnv, openRouterFetch, seedLearner, type FakeEnv } from './learning-fake-env';

const NOW = new Date('2026-10-26T03:00:00Z');
const mission = getMission('plan-weekend')!;
const constraintsStep = mission.steps.find((s) => s.id === 'constraints')!;
let env: FakeEnv;
let alice: LearnerContext;
let bob: LearnerContext;

beforeEach(async () => {
  env = fakeEnv();
  env.AI.run.mockRejectedValue(new Error('workers ai down'));
  alice = await seedLearner(env.DB, 'lrn_alice');
  bob = await seedLearner(env.DB, 'lrn_bob');
});

describe('hint ladder', () => {
  it('unlocks levels in order and records usage on the run', async () => {
    const { fetchImpl, calls } = openRouterFetch(() => 'Điều gì sẽ làm cuối tuần của bạn "hỏng" nếu AI không biết?');
    const deps = { env, fetchImpl, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    await expect(requestHint(deps, alice, run.id, 'constraints', 2)).rejects.toMatchObject({ code: 'forbidden' });
    const h1 = await requestHint(deps, alice, run.id, 'constraints', 1);
    expect(h1).toEqual({ level: 1, text: 'Điều gì sẽ làm cuối tuần của bạn "hỏng" nếu AI không biết?', origin: 'ai' });
    expect(calls[0].body.model).toBe('google/gemini-3.1-flash-lite');
    expect(await requestHint(deps, alice, run.id, 'constraints', 2)).toMatchObject({ level: 2, origin: 'ai' });
    await expect(requestHint(deps, alice, run.id, 'constraints', 4)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(requestHint(deps, alice, run.id, 'nope', 3)).rejects.toMatchObject({ code: 'invalid' });
    expect(await getRun(deps, alice, run.id)).toMatchObject({ hintMaxLevel: 2, hintsUsed: 2, rev: 0 });
    const stored = await env.DB.prepare(`SELECT COUNT(*) AS n FROM coach_messages WHERE learner_id = ? AND channel = 'hint'`).bind(alice.id).first<{ n: number }>();
    expect(stored?.n).toBe(2);
    const ev = await env.DB.prepare(`SELECT props_json FROM events WHERE name = 'hint.requested'`).all<{ props_json: string }>();
    expect(JSON.parse(ev.results[0].props_json)).toEqual({ stepId: 'constraints', level: 1, origin: 'ai' });
  });

  it('falls back to the authored static hint when every AI path fails', async () => {
    const deps = { env, fetchImpl: failingFetch(), now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    expect(await requestHint(deps, alice, run.id, 'constraints', 1)).toEqual({ level: 1, text: constraintsStep.hints[0], origin: 'static' });
  });

  it('falls back to static when the learner is over the AI budget and Workers AI is down', async () => {
    await env.DB.prepare('INSERT INTO ai_usage (day, learner_id, cost_usd) VALUES (?, ?, ?)').bind('2026-10-26', alice.id, 1).run();
    const { fetchImpl } = openRouterFetch(() => 'AI hint');
    const deps = { env, fetchImpl, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    expect((await requestHint(deps, alice, run.id, 'constraints', 1)).origin).toBe('static');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('practice chat', () => {
  it('replies, stores both messages and counts the daily allowance', async () => {
    const { fetchImpl, calls } = openRouterFetch(() => 'Bạn nên kiểm tra lại giờ mở cửa nhé.');
    const deps = { env, fetchImpl, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    const history = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, content: `tin ${i}` }));
    const res = await sendPracticeChat(deps, alice, { runId: run.id, stepId: 'ask-ai', messages: history });
    expect(res).toEqual({ reply: 'Bạn nên kiểm tra lại giờ mở cửa nhé.', model: 'google/gemini-3.1-flash-lite', remainingToday: PRACTICE_LIMITS.dailyMessages - 1 });
    const sent = calls[0].body as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(sent.messages).toHaveLength(1 + PRACTICE_LIMITS.historyMessages);
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toMatch(/kiểm tra lại/);
    expect(sent.messages[0].content).toContain(mission.title);
    expect(sent.max_tokens).toBe(PRACTICE_LIMITS.maxOutputTokens);
    const rows = await env.DB.prepare(`SELECT role FROM coach_messages WHERE channel = 'practice' ORDER BY role`).all<{ role: string }>();
    expect(rows.results.map((r) => r.role)).toEqual(['assistant', 'user']);
  });

  it('validates input and ownership of the run', async () => {
    const deps = { env, fetchImpl: openRouterFetch(() => 'x').fetchImpl, now: () => NOW };
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    await expect(sendPracticeChat(deps, bob, { runId: run.id, messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(sendPracticeChat(deps, alice, { messages: [{ role: 'assistant', content: 'hi' }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(sendPracticeChat(deps, alice, { messages: [{ role: 'user', content: 'x'.repeat(5000) }] })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('maps an AI outage to unavailable without storing messages', async () => {
    const deps = { env, fetchImpl: failingFetch(), now: () => NOW };
    await expect(sendPracticeChat(deps, alice, { messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'unavailable' });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM coach_messages').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
