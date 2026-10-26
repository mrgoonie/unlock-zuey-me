/**
 * Admin proposal and settings APIs: admin-only 404s (also while INSIGHTS_MODE=off), triage transitions,
 * file_issue without a token → 409, ai-handle confirmations, settings, and the token never appearing in any
 * response body.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { runProposalStage } from '../../src/lib/insights/proposal-stage';
import { GET as listRoute } from '../../src/pages/api/v1/admin/insights/proposals/index';
import { GET as detailRoute, PATCH as patchRoute } from '../../src/pages/api/v1/admin/insights/proposals/[id]';
import { GET as settingsGet, PATCH as settingsPatch } from '../../src/pages/api/v1/admin/insights/settings';
import { learnerCtx, routeContext } from './observer-seed-fixtures';
import { FAKE_TOKEN, freshDb, NOW, seedCohort, stubModel } from './insights-proposal-stage-fixtures';
import type { LearnerContext } from '../../src/lib/learning/types';

type Route = (ctx: never) => Response | Promise<Response>;
const admin = learnerCtx('lrn_admin', { isAdmin: true });
let db: D1Database;
let proposalId: string;

const call = (route: Route, opts: { learner?: LearnerContext; env?: Partial<Env>; params?: Record<string, string>; body?: unknown; url?: string } = {}) => {
  const url = opts.url ?? 'https://unlock.zuey.me/api/v1/admin/insights/proposals';
  const request = opts.body === undefined ? new Request(url) : new Request(url, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body),
  });
  return route(routeContext({
    learner: opts.learner ?? admin, env: { DB: db, INSIGHTS_MODE: 'internal', ...opts.env }, params: opts.params, url, request,
  }));
};
const patch = (body: unknown, env: Partial<Env> = {}) => call(patchRoute, { params: { id: proposalId }, body, env });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

beforeEach(async () => {
  db = await freshDb();
  await seedCohort(db);
  await runProposalStage({ DB: db, INSIGHTS_MODE: 'internal' } as Env, createCronBudget(), NOW, { draftModel: stubModel().model });
  proposalId = String(await db.prepare(`SELECT id FROM insight_proposals`).first('id'));
});

describe('admin gate', () => {
  it('answers 404 to non-admins, guests, and everyone (admins too) while INSIGHTS_MODE=off', async () => {
    const member = learnerCtx('lrn_a');
    const cases: Array<[Route, Record<string, string>]> = [[listRoute, {}], [detailRoute, { id: proposalId }], [settingsGet, {}]];
    for (const [route, params] of cases) {
      expect((await call(route, { learner: member, params })).status).toBe(404);
      expect((await call(route, { env: { INSIGHTS_MODE: 'off' }, params })).status).toBe(404);
      expect((await call(route, { env: { INSIGHTS_MODE: undefined }, params })).status).toBe(404);
    }
    expect((await call(patchRoute, { learner: member, params: { id: proposalId }, body: { action: 'approve_ai_handle' } })).status).toBe(404);
    expect((await call(settingsPatch, { learner: member, body: { safeAutoImplement: true, confirm: 'BAT' } })).status).toBe(404);
  });
});

describe('proposals API', () => {
  it('lists proposals with gate, risk, cohort stats and settings; filters by status', async () => {
    const res = await call(listRoute);
    const body = (await res.json()) as { proposals: Array<Record<string, unknown>>; settings: Record<string, unknown> };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({
      id: proposalId, status: 'proposed', risk: 'low', category: 'content', area: 'mission:plan-weekend',
      gate: { decision: 'proposal', reasons: ['github_off', 'no_token'] }, stats: { learners: 3, occurrences: 3 }, issue: null,
    });
    expect(body.settings).toEqual({ githubMode: 'off', tokenConfigured: false, safeAutoImplement: false, dailyCap: 3, issuesFiledToday: 0 });
    const filtered = await call(listRoute, { url: 'https://unlock.zuey.me/api/v1/admin/insights/proposals?status=rejected' });
    expect(((await filtered.json()) as { proposals: unknown[] }).proposals).toHaveLength(0);
    expect((await call(listRoute, { url: 'https://unlock.zuey.me/x?status=merged' })).status).toBe(400);
  });

  it('returns the detail with copyable, privacy-checked issue markdown', async () => {
    const res = await call(detailRoute, { params: { id: proposalId } });
    const d = (await res.json()) as { issueMarkdown: string; privacyHits: string[]; proposal: { stats: { learners: number } } };
    expect(d.issueMarkdown).toContain('## Aggregated evidence (3 learners');
    expect(d.privacyHits).toEqual([]);
    expect((await call(detailRoute, { params: { id: 'prp_missing' } })).status).toBe(404);
    expect((await call(detailRoute, { params: { id: '../etc' } })).status).toBe(404);
  });

  it('applies triage transitions and rejects invalid ones with 409', async () => {
    expect((await patch({ action: 'mark_shipped' })).status).toBe(409); // proposed → shipped is not allowed
    expect((await patch({ action: 'accept' })).status).toBe(200);
    expect((await patch({ action: 'accept' })).status).toBe(409);
    expect((await patch({ action: 'mark_duplicate', duplicateOf: '#12' })).status).toBe(200);
    const row = await db.prepare(`SELECT status, duplicate_of, decided_by FROM insight_proposals`).first();
    expect(row).toEqual({ status: 'duplicate', duplicate_of: '#12', decided_by: 'lrn_admin' });
    expect((await patch({ action: 'reopen' })).status).toBe(200);
    expect((await patch({ action: 'reject' })).status).toBe(200);
    expect((await patch({ action: 'reject' })).status).toBe(409);
    expect((await patch({ action: 'explode' })).status).toBe(400);
    expect((await call(patchRoute, { params: { id: 'prp_missing' }, body: { action: 'accept' } })).status).toBe(404);
  });

  it('file_issue answers 409 without a token, even with INSIGHTS_GITHUB_ISSUES set', async () => {
    const res = await patch({ action: 'file_issue' }, { INSIGHTS_GITHUB_ISSUES: 'issues_ai_handle' });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toMatch(/Sao chép nội dung issue/);
  });

  it('approve_ai_handle needs the confirm text (400), the ai-handle mode (409), and confirmHighRisk for high risk', async () => {
    expect((await patch({ action: 'approve_ai_handle' })).status).toBe(400);
    expect((await patch({ action: 'approve_ai_handle', confirm: 'yes' })).status).toBe(400);
    expect((await patch({ action: 'approve_ai_handle', confirm: 'AI-HANDLE' })).status).toBe(409);
    const ghEnv = { INSIGHTS_GITHUB_ISSUES: 'issues_ai_handle', GITHUB_ISSUES_TOKEN: FAKE_TOKEN };
    await db.prepare(`UPDATE insight_signals SET area = 'settings', title = '[bug] settings: reset login session'`).run();
    const high = await patch({ action: 'approve_ai_handle', confirm: 'AI-HANDLE' }, ghEnv);
    expect(high.status).toBe(400);
    expect((await errorOf(high)).message).toMatch(/confirmHighRisk/);
    const ok = await patch({ action: 'approve_ai_handle', confirm: 'AI-HANDLE', confirmHighRisk: true }, ghEnv);
    expect(ok.status).toBe(200);
    expect(await db.prepare(`SELECT ai_handle_approved_by FROM insight_proposals`).first('ai_handle_approved_by')).toBe('lrn_admin');
  });
});

describe('settings API', () => {
  it('reports tokenConfigured as a boolean and toggles safe_auto_implement only with confirm BAT', async () => {
    const get = await call(settingsGet);
    expect(await get.json()).toMatchObject({ githubMode: 'off', tokenConfigured: false, safeAutoImplement: false });
    expect((await call(settingsPatch, { body: { safeAutoImplement: true } })).status).toBe(400);
    expect((await call(settingsPatch, { body: { safeAutoImplement: true, confirm: 'bat?' } })).status).toBe(400);
    const on = await call(settingsPatch, { body: { safeAutoImplement: true, confirm: 'BAT' } });
    expect(await on.json()).toMatchObject({ safeAutoImplement: true });
    expect(await db.prepare(`SELECT updated_by FROM insight_operator_settings WHERE key = 'safe_auto_implement'`).first('updated_by')).toBe('lrn_admin');
  });
});

describe('credential isolation', () => {
  it('no insights admin response body ever contains the token', async () => {
    const env = { INSIGHTS_GITHUB_ISSUES: 'issues_ai_handle', GITHUB_ISSUES_TOKEN: FAKE_TOKEN };
    const responses = [
      await call(listRoute, { env }),
      await call(detailRoute, { env, params: { id: proposalId } }),
      await call(settingsGet, { env }),
      await call(settingsPatch, { env, body: { safeAutoImplement: false, confirm: 'BAT' } }),
      await call(patchRoute, { env, params: { id: proposalId }, body: { action: 'accept' } }),
      await call(patchRoute, { env, params: { id: proposalId }, body: { action: 'approve_ai_handle' } }),
      await call(listRoute, { env, learner: learnerCtx('lrn_a') }),
    ];
    for (const res of responses) expect(await res.text()).not.toContain(FAKE_TOKEN);
    const settings = await (await call(settingsGet, { env })).json();
    expect(settings).toMatchObject({ tokenConfigured: true, githubMode: 'issues_ai_handle' });
  });
});
