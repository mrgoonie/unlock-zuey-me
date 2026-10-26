/**
 * With INSIGHTS_MODE unset (production today) nothing changes for anyone: every insights, ingest and /skill
 * route handler answers 404 without touching D1 or KV, the cron job is a free no-op, MCP scopes and the
 * observer detail are unchanged, and the only request-policy change is `/api/ingest/**` → no session.
 *
 * Route handlers are discovered with import.meta.glob, so a route added later is covered automatically.
 */
import { describe, expect, it } from 'vitest';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { runInsightsPipeline } from '../../src/lib/insights/pipeline-job';
import { learnerPolicy } from '../../src/lib/identity/request-policy';
import { MCP_SCOPES } from '../../src/lib/mcp/mcp-scopes';
import { GET as observerDetailRoute } from '../../src/pages/api/v1/admin/learners/[id]/index';
import { GET as observerListRoute } from '../../src/pages/api/v1/admin/learners/index';
import { createTestD1 } from '../helpers/d1-sqlite';
import { learnerCtx, routeContext, seedLearner } from './observer-seed-fixtures';

type Handler = (ctx: never) => Response | Promise<Response>;
type RouteModule = Partial<Record<'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', Handler>>;

const routeModules = import.meta.glob<RouteModule>([
  '../../src/pages/api/ingest/**/*.ts',
  '../../src/pages/api/v1/insights/**/*.ts',
  '../../src/pages/api/v1/admin/insights/**/*.ts',
  '../../src/pages/skill/**/*.ts',
  '!**/_*.ts',
], { eager: true });

const handlers = Object.entries(routeModules).flatMap(([file, mod]) =>
  (['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const).filter((m) => typeof mod[m] === 'function').map((m) => ({ file, method: m, handler: mod[m]! })));

/** Any property access on these throws, proving a handler never reached storage. */
const poisoned = (name: string) => new Proxy({}, { get: (_t, prop) => { throw new Error(`${name}.${String(prop)} used while the feature is off`); } });

const offEnvs: Array<Partial<Env>> = [{}, { INSIGHTS_MODE: 'off' }, { INSIGHTS_MODE: 'bogus' }, { INSIGHTS_MODE: '' }];

function requestFor(file: string, method: string): Request {
  const body = method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ analysis: true, label: 'x', adapter: 'claude-code' });
  return new Request('https://unlock.zuey.me/api/test', {
    method,
    headers: {
      'content-type': 'application/json',
      // A syntactically valid ingest token: the 404 must come before any token lookup.
      authorization: `Bearer aiu_ing_${'A'.repeat(43)}`,
      'cf-connecting-ip': '203.0.113.7',
      'user-agent': file.includes('/ingest/') ? 'node' : 'Mozilla/5.0',
    },
    body,
  });
}

describe('INSIGHTS_MODE off: no behaviour change', () => {
  it('discovers every insights, ingest and /skill route handler', () => {
    // 19 route files with 21 handlers at the time of writing; the floor keeps the sweep below from passing vacuously.
    expect(Object.keys(routeModules).length).toBeGreaterThanOrEqual(19);
    expect(handlers.length).toBeGreaterThanOrEqual(21);
    expect(handlers.some((h) => h.file.endsWith('ingest/v1/turns.ts') && h.method === 'POST')).toBe(true);
    expect(handlers.some((h) => h.file.endsWith('skill/manifest.json.ts'))).toBe(true);
  });

  // Handler level: an admin, a member and no learner at all. (In production the middleware already answers a
  // session-less /api/v1 request 401 before routing, exactly as for a path that does not exist; e2e checks that.)
  it('every handler answers 404, even for an admin member with a bearer token, and never touches D1 or KV', async () => {
    const learners = [learnerCtx('lrn_admin', { isAdmin: true, email: 'admin@example.com' }), learnerCtx('lrn_member'), undefined];
    for (const over of offEnvs) {
      const env = { ...over, DB: poisoned('DB'), CACHE: poisoned('CACHE'), ADMIN_EMAILS: 'admin@example.com' } as unknown as Env;
      for (const learner of learners) {
        for (const { file, method, handler } of handlers) {
          const ctx = routeContext({ learner, env, params: { id: 'irp_x', path: 'SKILL.md' }, request: requestFor(file, method) });
          const res = await handler(ctx);
          expect(res.status, `${method} ${file} as ${learner?.id ?? 'nobody'} with ${JSON.stringify(over)}`).toBe(404);
        }
      }
    }
  });

  it('the cron job returns flag_off with the real stages and charges nothing', async () => {
    for (const over of offEnvs) {
      const env = { ...over, DB: poisoned('DB'), CACHE: poisoned('CACHE') } as unknown as Env;
      const budget = createCronBudget({ d1Queries: 100, subrequests: 1000 });
      expect(await runInsightsPipeline(env, budget, new Date('2026-10-26T16:00:00.000Z'))).toEqual({ skipped: 'flag_off' });
      expect(budget.remainingD1Queries()).toBe(100);
      expect(budget.remainingSubrequests()).toBe(1000);
    }
  });

  it('keeps the MCP scopes exactly as before', () => {
    expect([...MCP_SCOPES]).toEqual(['learn:read', 'learn:write']);
  });

  it('keeps the observer list and detail shapes, and never exposes insight tables through them', async () => {
    const db = createTestD1();
    await seedLearner(db, 'lrn_wife', { consent: true, name: 'Vợ' }); // seeds a row in every insight table too
    const admin = learnerCtx('lrn_admin', { isAdmin: true });
    const env = { DB: db };

    const detailRes = await observerDetailRoute(routeContext({ learner: admin, env, params: { id: 'lrn_wife' } }));
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toMatchInlineSnapshot(`
      [
        "coach",
        "competencies",
        "evaluations",
        "evidence",
        "firstWin",
        "funnel",
        "hints",
        "learner",
        "timeline",
      ]
    `);

    const listRes = await observerListRoute(routeContext({ learner: admin, env }));
    const list = await listRes.json() as { learners: Array<Record<string, unknown>> };
    expect(Object.keys(list).sort()).toEqual(['learners']);
    expect(Object.keys(list.learners[0]).sort()).toMatchInlineSnapshot(`
      [
        "consentAt",
        "displayName",
        "id",
        "joinedAt",
        "kind",
        "lastActiveAt",
        "missionsDone",
        "xp",
      ]
    `);

    // The seeded insight rows (report irp_lrn_wife, token itk_lrn_wife, intent "Mục tiêu của lrn_wife") stay invisible.
    for (const body of [detail, list]) {
      const text = JSON.stringify(body);
      for (const leak of ['irp_lrn_wife', 'itk_lrn_wife', 'iev_lrn_wife', 'Mục tiêu của lrn_wife', 'insight']) expect(text).not.toContain(leak);
    }
  });

  it('changes the session policy for /api/ingest only', () => {
    const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36';
    // The one change: ingest never resolves or creates a cookie session, for any client or method.
    for (const path of ['/api/ingest/v1/turns', '/api/ingest/v1/status', '/api/ingest/v1/pair/start', '/api/ingest']) {
      for (const [method, ua] of [['POST', 'node'], ['POST', chrome], ['GET', chrome], ['DELETE', null]] as const) {
        expect(learnerPolicy(path, method, ua), `${method} ${path}`).toBe('none');
      }
    }
    // Every other insights surface follows the policy of an equivalent pre-existing path.
    const sameAs: Array<[newPath: string, existing: string]> = [
      ['/api/v1/insights/reports', '/api/v1/missions'],
      ['/api/v1/insights/consent', '/api/v1/me/consent'],
      ['/api/v1/admin/insights/summary', '/api/v1/admin/learners'],
      ['/insights', '/progress'],
      ['/insights/pair', '/missions/plan-weekend'],
      ['/admin/insights', '/admin'],
      ['/skill', '/settings'],
      ['/skill/manifest.json', '/manifest.webmanifest'],
      ['/skill/install.mjs', '/sw.js'],
    ];
    for (const [fresh, existing] of sameAs) {
      for (const [method, ua] of [['GET', chrome], ['POST', chrome], ['GET', 'curl/8.0'], ['GET', null]] as const) {
        expect(learnerPolicy(fresh, method, ua), `${method} ${fresh} (${ua})`).toBe(learnerPolicy(existing, method, ua));
      }
    }
  });
});
