/**
 * Abandoning an open run ("Bỏ lượt này"): owner only, idempotent, refused for completed or grading runs,
 * frees the one-open-run-per-mission slot, grants nothing. Covered at the service, the HTTP route and the
 * abandon_mission MCP tool.
 */
import type { APIContext } from 'astro';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetFallbackLimiter } from '../../src/lib/identity/request-rate-limits';
import {
  abandonRun, getProgress, getRun, openMission, saveAnswers, startMission, submitEvidence, type LearningDeps,
} from '../../src/lib/learning/service';
import type { LearnerContext } from '../../src/lib/learning/types';
import { registerRunTools } from '../../src/lib/mcp/tools/run-tools';
import { POST as abandonRoute } from '../../src/pages/api/v1/runs/[id]/abandon';
import { fakeEnv, gradeAll, openRouterFetch, planWeekendAnswers, seedLearner, type FakeEnv } from './learning-fake-env';

const NOW = new Date('2026-10-26T03:00:00Z');
let env: FakeEnv;
let alice: LearnerContext;
let bob: LearnerContext;
let deps: LearningDeps;

/** Parsed JSON error/run body of a route response. */
const body = async (r: Response) => (await r.json()) as { error?: { code: string }; run?: { id: string; status: string } };
const count = async (sql: string, ...args: unknown[]) => Number((await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n);

beforeEach(async () => {
  env = fakeEnv();
  alice = await seedLearner(env.DB, 'lrn_alice');
  bob = await seedLearner(env.DB, 'lrn_bob');
  deps = { env, now: () => NOW };
  resetFallbackLimiter();
});

describe('abandonRun (service)', () => {
  it('abandons the owner\'s open run once, records the event and grants nothing', async () => {
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    await saveAnswers(deps, alice, run.id, { stepId: 'constraints', answers: planWeekendAnswers.constraints, rev: run.rev });
    const abandoned = await abandonRun(deps, alice, run.id);
    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.rev).toBe(2);
    expect(abandoned.completedAt).toBeNull();
    // Idempotent: same run back, no second write or event.
    const again = await abandonRun(deps, alice, run.id);
    expect(again).toMatchObject({ status: 'abandoned', rev: 2 });
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE name = 'mission.abandoned' AND run_id = ?`, run.id)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM evaluations WHERE run_id = ?', run.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM xp_ledger WHERE learner_id = ?', alice.id)).toBe(0);
    expect((await getProgress(deps, alice)).xp).toBe(0);
    // An abandoned run can no longer be edited.
    await expect(saveAnswers(deps, alice, run.id, { stepId: 'reflect', answers: planWeekendAnswers.reflect, rev: 2 }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets the learner start a fresh run afterwards (one open run per mission)', async () => {
    const first = await startMission(deps, alice, 'plan-weekend', 'web');
    await abandonRun(deps, alice, first.id);
    const opened = await openMission(deps, alice, 'plan-weekend', 'web');
    expect(opened.id).not.toBe(first.id);
    expect(opened).toMatchObject({ status: 'started', rev: 0, answers: {} });
    expect(await count(`SELECT COUNT(*) AS n FROM mission_runs WHERE learner_id = ? AND status NOT IN ('completed', 'abandoned')`, alice.id)).toBe(1);
    expect((await getRun(deps, alice, first.id)).status).toBe('abandoned');
  });

  it('hides another learner\'s run as not_found and leaves it untouched', async () => {
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    await expect(abandonRun(deps, bob, run.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(abandonRun(deps, alice, 'run_missing')).rejects.toMatchObject({ code: 'not_found' });
    expect((await getRun(deps, alice, run.id)).status).toBe('started');
  });

  it('refuses a completed run and a run still being graded, but allows a crashed evaluation', async () => {
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    let current = run;
    for (const [stepId, answers] of Object.entries(planWeekendAnswers)) current = await saveAnswers(deps, alice, run.id, { stepId, answers, rev: current.rev });
    const passing = { ...deps, fetchImpl: openRouterFetch((b) => gradeAll(b, 0.95)).fetchImpl };
    const result = await submitEvidence(passing, alice, run.id, { idempotencyKey: 'key-00000001', source: 'web' });
    expect(result.run.status).toBe('completed');
    await expect(abandonRun(deps, alice, run.id)).rejects.toMatchObject({ code: 'conflict' });
    expect((await getRun(deps, alice, run.id)).status).toBe('completed');

    const second = await startMission(deps, alice, 'plan-weekend', 'web');
    await env.DB.prepare(`UPDATE mission_runs SET status = 'evaluating', updated_at = ? WHERE id = ?`).bind(NOW.toISOString(), second.id).run();
    await expect(abandonRun(deps, alice, second.id)).rejects.toMatchObject({ code: 'conflict' });
    // Ten minutes later the evaluation counts as crashed (evaluation_failed) and may be abandoned.
    const later = { env, now: () => new Date(NOW.getTime() + 10 * 60_000) };
    expect((await abandonRun(later, alice, second.id)).status).toBe('abandoned');
  });
});

describe('POST /api/v1/runs/:id/abandon', () => {
  const call = (learner: LearnerContext | undefined, id: string) => {
    const url = new URL(`https://unlock.zuey.me/api/v1/runs/${id}/abandon`);
    const ctx = { request: new Request(url, { method: 'POST' }), url, params: { id }, locals: { learner, runtime: { env } } };
    return abandonRoute(ctx as unknown as APIContext) as Promise<Response>;
  };

  it('returns the abandoned run to its owner, 404 to others, 401 without a learner, 409 when completed', async () => {
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    expect((await call(undefined, run.id)).status).toBe(401);
    const foreign = await call(bob, run.id);
    expect(foreign.status).toBe(404);
    expect((await body(foreign)).error?.code).toBe('not_found');
    const ok = await call(alice, run.id);
    expect(ok.status).toBe(200);
    expect((await body(ok)).run).toMatchObject({ id: run.id, status: 'abandoned' });
    expect((await call(alice, run.id)).status).toBe(200);

    await env.DB.prepare(`UPDATE mission_runs SET status = 'completed' WHERE id = ?`).bind(run.id).run();
    const done = await call(alice, run.id);
    expect(done.status).toBe(409);
    expect((await body(done)).error?.code).toBe('conflict');
  });

  it('is repeatable and still hides the run from another learner', async () => {
    const run = await startMission(deps, alice, 'plan-weekend', 'web');
    for (let i = 0; i < 3; i++) expect((await call(alice, run.id)).status).toBe(200);
    expect((await call(bob, run.id)).status).toBe(404);
  });
});

describe('abandon_mission MCP tool', () => {
  type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
  function tools(learner: LearnerContext, scopes: string[]) {
    const handlers = new Map<string, Handler>();
    const server = { registerTool: (name: string, _config: unknown, handler: Handler) => void handlers.set(name, handler) };
    registerRunTools(server as unknown as McpServer, { env, learner, scopes });
    return handlers;
  }

  it('abandons with learn:write, is refused with learn:read only, and hides foreign runs', async () => {
    const run = await startMission(deps, alice, 'plan-weekend', 'mcp');
    const readOnly = await tools(alice, ['learn:read']).get('abandon_mission')!({ run_id: run.id });
    expect(readOnly.structuredContent).toMatchObject({ error: { code: 'insufficient_scope' } });
    expect((await getRun(deps, alice, run.id)).status).toBe('started');

    const foreign = await tools(bob, ['learn:write']).get('abandon_mission')!({ run_id: run.id });
    expect(foreign).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } });

    const ok = await tools(alice, ['learn:write']).get('abandon_mission')!({ run_id: run.id });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toMatchObject({ run: { id: run.id, status: 'abandoned' } });
  });
});
