import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { GET as listRoute } from '../../src/pages/api/v1/insights/reports/index';
import { DELETE as deleteRoute } from '../../src/pages/api/v1/insights/reports/[id]';
import { POST as feedbackRoute } from '../../src/pages/api/v1/insights/reports/[id]/feedback';
import { POST as deleteAllRoute } from '../../src/pages/api/v1/insights/reports/delete-all';
import { listReports, toInstant, type InsightReportView } from '../../src/lib/insights/learner-report-queries';
import { learnerCtx, routeContext } from './observer-seed-fixtures';

let db: D1Database;
const A = learnerCtx('lrn_a');
const B = learnerCtx('lrn_b');
const SESSION_1 = 'a'.repeat(64);
const SESSION_2 = 'b'.repeat(64);
const FUTURE = '2099-01-01T00:00:00.000Z';
const env = (over: Partial<Env> = {}) => ({ DB: db, INSIGHTS_MODE: 'on', ...over });

async function insertLearner(id: string) {
  await db.prepare(`INSERT INTO learners (id, kind, display_name, email, profile_json, created_at, updated_at)
    VALUES (?, 'member', ?, ?, '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).bind(id, id, `${id}@example.com`).run();
}

async function insertReport(o: {
  id: string; learnerId: string; createdAt: string; session?: string; missionId?: string | null; skills?: string[]; expiresAt?: string;
}) {
  const report = {
    relevant: true,
    intent_summary: { text: `Mục tiêu ${o.id}`, confidence: 0.8 },
    workflow_observed: [{ step: 'Hỏi AI lập kế hoạch', evidence_ref: 'e1' }],
    learning_insights: (o.skills ?? ['verify']).map((skill) => ({ skill, note: `Ghi chú ${skill}` })),
    verification_gaps: [{ note: 'Chưa kiểm tra giá vé', evidence_ref: 'e1' }],
    risk_signals: [],
    next_best_action: { text: 'Thử mission kiểm chứng', mission_id: 'plan-weekend' },
    product_observation: { category: 'ux', area: 'mcp', topic_key: 'secret-topic', summary: 'OPERATOR ONLY', evidence_ref: 'e1', confidence: 0.9 },
    confidence: 0.75,
    source_runtime: 'claude-code', created_at: o.createdAt, model: 'flash-lite', prompt_version: 1, evidence_refs: ['e1'],
  };
  await db.prepare(`INSERT INTO insight_reports (id, learner_id, session_ref, mission_id, report_json, intent_summary, skills_json, confidence,
      has_product_observation, source_runtime, model, prompt_version, event_count, window_started_at, window_ended_at, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0.75, 1, 'claude-code', 'flash-lite', 1, 3, ?, ?, ?, ?)`)
    .bind(o.id, o.learnerId, o.session ?? SESSION_1, o.missionId ?? null, JSON.stringify(report), `Mục tiêu ${o.id}`,
      JSON.stringify(o.skills ?? ['verify']), o.createdAt, o.createdAt, o.createdAt, o.expiresAt ?? FUTURE).run();
}

async function insertEvent(id: string, learnerId: string, status: string) {
  await db.prepare(`INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json,
      payload_bytes, status, next_attempt_at, turn_ended_at, received_at)
    VALUES (?, ?, ?, ?, 'claude-code', '0.1.0', ?, 10, ?, '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z', '2026-10-26T01:00:00.000Z')`)
    .bind(id, learnerId, `idem_${id}`, SESSION_1, status === 'pending' || status === 'processing' ? '{"turn":{}}' : null, status).run();
}

const get = (learner = A, query = '', over: Partial<Env> = {}) =>
  listRoute(routeContext({ learner, env: env(over), url: `https://unlock.zuey.me/api/v1/insights/reports${query}` }));
const post = (route: (ctx: never) => Response | Promise<Response>, learner: typeof A, body: unknown, params: Record<string, string> = {}, over: Partial<Env> = {}) =>
  route(routeContext({
    learner, env: env(over), params,
    request: new Request('https://unlock.zuey.me/api/v1/insights/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }));
const del = (learner: typeof A, id: string, over: Partial<Env> = {}) => deleteRoute(routeContext({ learner, env: env(over), params: { id } }));

type ListBody = { reports: InsightReportView[]; nextCursor: string | null; sessions: Array<{ ref: string; label: string }>; queue: { pending: number; lastReceivedAt: string | null } };

beforeEach(async () => {
  db = createTestD1();
  await insertLearner('lrn_a');
  await insertLearner('lrn_b');
  await insertReport({ id: 'irp_a1', learnerId: 'lrn_a', createdAt: '2026-10-20T03:00:00.000Z', skills: ['describe'], missionId: 'plan-weekend' });
  await insertReport({ id: 'irp_a2', learnerId: 'lrn_a', createdAt: '2026-10-25T03:00:00.000Z', skills: ['verify'], session: SESSION_2 });
  await insertReport({ id: 'irp_a_old', learnerId: 'lrn_a', createdAt: '2026-07-01T03:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' });
  await insertReport({ id: 'irp_b1', learnerId: 'lrn_b', createdAt: '2026-10-24T03:00:00.000Z', skills: ['describe'], missionId: 'plan-weekend' });
});

describe('GET /api/v1/insights/reports', () => {
  it('lists only the learner’s own unexpired reports, newest first, with sessions and queue state', async () => {
    await insertEvent('iev_p', 'lrn_a', 'pending');
    await insertEvent('iev_d', 'lrn_a', 'done');
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.reports.map((r) => r.id)).toEqual(['irp_a2', 'irp_a1']);
    expect(body.sessions.map((s) => s.ref)).toEqual([SESSION_2, SESSION_1]);
    expect(body.sessions[0].label).toMatch(/^Phiên 2 \(25\/10\)$/);
    expect(body.queue).toEqual({ pending: 1, lastReceivedAt: '2026-10-26T01:00:00.000Z' });
    const r = body.reports[0];
    expect(r.intent).toEqual({ text: 'Mục tiêu irp_a2', confidence: 0.8 });
    expect(r.provenance).toMatchObject({ sourceRuntime: 'claude-code', model: 'flash-lite', eventCount: 3, promptVersion: 1 });
    expect(r.next).toEqual({ text: 'Thử mission kiểm chứng', missionId: 'plan-weekend' });
    // The product observation is an operator pipeline input and never reaches the learner.
    expect(JSON.stringify(body)).not.toContain('OPERATOR ONLY');
    expect(JSON.stringify(body)).not.toContain('irp_b1');
  });

  it('applies filters without widening the scope to other learners', async () => {
    const bySkill = (await (await get(A, '?skill=describe')).json()) as ListBody;
    expect(bySkill.reports.map((r) => r.id)).toEqual(['irp_a1']);
    const byMission = (await (await get(A, '?mission=plan-weekend')).json()) as ListBody;
    expect(byMission.reports.map((r) => r.id)).toEqual(['irp_a1']);
    const bySession = (await (await get(A, `?session=${SESSION_2}`)).json()) as ListBody;
    expect(bySession.reports.map((r) => r.id)).toEqual(['irp_a2']);
    const byRange = (await (await get(A, '?from=2026-10-21&to=2026-10-25')).json()) as ListBody;
    expect(byRange.reports.map((r) => r.id)).toEqual(['irp_a2']);
    const empty = (await (await get(A, '?skill=operate')).json()) as ListBody;
    expect(empty.reports).toEqual([]);
  });

  it('paginates with a keyset cursor', async () => {
    const first = (await (await get(A, '?limit=1')).json()) as ListBody;
    expect(first.reports.map((r) => r.id)).toEqual(['irp_a2']);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (await get(A, `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json()) as ListBody;
    expect(second.reports.map((r) => r.id)).toEqual(['irp_a1']);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects malformed filters with 400', async () => {
    for (const q of ['?skill=hacking', '?limit=500', '?from=not-a-date', '?session=xyz', "?mission=a'b"]) {
      expect((await get(A, q)).status).toBe(400);
    }
  });

  it('reads Asia/Saigon day bounds', () => {
    expect(toInstant('2026-10-26', 'start')).toBe('2026-10-25T17:00:00.000Z');
    expect(toInstant('2026-10-26', 'end')).toBe('2026-10-26T16:59:59.999Z');
    expect(toInstant('garbage', 'start')).toBeUndefined();
    expect(toInstant('', 'start')).toBeNull();
  });
});

describe('cross-user access', () => {
  it('learner B cannot delete or rate A’s report (404) and A’s report is untouched', async () => {
    expect((await del(B, 'irp_a1')).status).toBe(404);
    expect((await post(feedbackRoute, B, { useful: true }, { id: 'irp_a1' })).status).toBe(404);
    const row = await db.prepare('SELECT useful FROM insight_reports WHERE id = ?').bind('irp_a1').first<{ useful: number | null }>();
    expect(row).toEqual({ useful: null });
    const bList = (await (await get(B)).json()) as ListBody;
    expect(bList.reports.map((r) => r.id)).toEqual(['irp_b1']);
  });

  it('an unknown id is 404 too', async () => {
    expect((await del(A, 'irp_missing')).status).toBe(404);
    expect((await post(feedbackRoute, A, { useful: false }, { id: 'irp_missing' })).status).toBe(404);
  });
});

describe('feedback, delete and delete-all', () => {
  it('records useful / not useful', async () => {
    expect((await post(feedbackRoute, A, { useful: true }, { id: 'irp_a1' })).status).toBe(200);
    let page = await listReports(db, 'lrn_a');
    expect(page.reports.find((r) => r.id === 'irp_a1')?.useful).toBe(true);
    expect((await post(feedbackRoute, A, { useful: false }, { id: 'irp_a1' })).status).toBe(200);
    page = await listReports(db, 'lrn_a');
    expect(page.reports.find((r) => r.id === 'irp_a1')?.useful).toBe(false);
    expect((await post(feedbackRoute, A, { useful: 'yes' }, { id: 'irp_a1' })).status).toBe(400);
  });

  it('deletes one report', async () => {
    const res = await del(A, 'irp_a1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await listReports(db, 'lrn_a')).reports.map((r) => r.id)).toEqual(['irp_a2']);
  });

  it('delete-all needs the confirm word, removes all reports and pending events, and leaves others alone', async () => {
    await insertEvent('iev_p', 'lrn_a', 'pending');
    await insertEvent('iev_w', 'lrn_a', 'processing');
    await insertEvent('iev_d', 'lrn_a', 'done');
    await insertEvent('iev_b', 'lrn_b', 'pending');
    expect((await post(deleteAllRoute, A, { confirm: 'xoa' })).status).toBe(400);
    const res = await post(deleteAllRoute, A, { confirm: 'XOA' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 3 });
    const left = await db.prepare('SELECT id FROM insight_events ORDER BY id').all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual(['iev_b', 'iev_d']);
    const reports = await db.prepare('SELECT id FROM insight_reports ORDER BY id').all<{ id: string }>();
    expect(reports.results.map((r) => r.id)).toEqual(['irp_b1']);
  });
});

describe('feature flag and session', () => {
  it('every route is 404 when the feature is off or not enabled for this learner', async () => {
    for (const over of [{ INSIGHTS_MODE: 'off' }, { INSIGHTS_MODE: undefined }, { INSIGHTS_MODE: 'internal' }, { INSIGHTS_MODE: 'pilot', INSIGHTS_PILOT_EMAILS: 'x@example.com' }]) {
      expect((await get(A, '', over)).status).toBe(404);
      expect((await del(A, 'irp_a1', over)).status).toBe(404);
      expect((await post(feedbackRoute, A, { useful: true }, { id: 'irp_a1' }, over)).status).toBe(404);
      expect((await post(deleteAllRoute, A, { confirm: 'XOA' }, {}, over)).status).toBe(404);
    }
    expect((await db.prepare('SELECT COUNT(*) AS n FROM insight_reports').first<{ n: number }>())?.n).toBe(4);
  });

  it('pilot learners and admins in internal mode get access; guests never do', async () => {
    expect((await get(A, '', { INSIGHTS_MODE: 'pilot', INSIGHTS_PILOT_EMAILS: 'LRN_A@example.com' })).status).toBe(200);
    expect((await get(learnerCtx('lrn_a', { isAdmin: true }), '', { INSIGHTS_MODE: 'internal' })).status).toBe(200);
    expect((await get(learnerCtx('lrn_a', { kind: 'guest' }))).status).toBe(404);
  });

  it('no learner → 401', async () => {
    const res = await listRoute(routeContext({ env: env() }));
    expect(res.status).toBe(401);
  });
});
