import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { GET as reportsRoute } from '../../src/pages/api/v1/admin/insights/learners/[id]/reports';
import { GET as summaryRoute } from '../../src/pages/api/v1/admin/insights/summary';
import { PATCH as observerConsentRoute } from '../../src/pages/api/v1/me/consent';
import { viewLearnerReportsAsOperator } from '../../src/lib/insights/operator-access-audit';
import { learnerCtx, routeContext } from './observer-seed-fixtures';

let db: D1Database;
const admin = learnerCtx('lrn_admin', { isAdmin: true });
const T = '2026-10-25T03:00:00.000Z';
const env = (over: Partial<Env> = {}) => ({ DB: db, INSIGHTS_MODE: 'internal', ...over });

async function seed(id: string, o: { observer: boolean; analysis: boolean; share: boolean }) {
  await db.batch([
    db.prepare(`INSERT INTO learners (id, kind, display_name, email, profile_json, observer_consent, observer_consent_at, created_at, updated_at)
      VALUES (?, 'member', ?, ?, '{}', ?, ?, ?, ?)`).bind(id, `Tên ${id}`, `${id}@example.com`, o.observer ? 1 : 0, o.observer ? T : null, T, T),
    db.prepare(`INSERT INTO insight_consents (learner_id, analysis, share_operator, proposals, analysis_at, share_operator_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)`).bind(id, o.analysis ? 1 : 0, o.share ? 1 : 0, T, o.share ? T : null, T),
    db.prepare(`INSERT INTO insight_reports (id, learner_id, session_ref, report_json, intent_summary, confidence, source_runtime, model,
        prompt_version, event_count, window_started_at, window_ended_at, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 0.7, 'claude-code', 'flash-lite', 1, 2, ?, ?, ?, '2099-01-01T00:00:00.000Z')`)
      .bind(`irp_${id}`, id, 'c'.repeat(64), JSON.stringify({ relevant: true, intent_summary: { text: `Mục tiêu ${id}`, confidence: 0.7 } }),
        `Mục tiêu ${id}`, T, T, T),
    db.prepare(`INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json,
        payload_bytes, status, next_attempt_at, turn_ended_at, received_at)
      VALUES (?, ?, ?, ?, 'claude-code', '0.1.0', ?, 40, 'pending', ?, ?, ?)`)
      .bind(`iev_${id}`, id, `idem_${id}`, 'c'.repeat(64), JSON.stringify({ turn: { userPrompt: `RAW PROMPT ${id}` } }), T, T, T),
  ]);
}

const view = (id: string, learner = admin, over: Partial<Env> = {}) =>
  reportsRoute(routeContext({ learner, env: env(over), params: { id } }));
const auditCount = async (id: string) =>
  Number((await db.prepare('SELECT COUNT(*) AS n FROM insight_access_audit WHERE learner_id = ?').bind(id).first<{ n: number }>())?.n);

beforeEach(async () => {
  db = createTestD1();
  await seed('lrn_both', { observer: true, analysis: true, share: true });
  await seed('lrn_share_only', { observer: false, analysis: true, share: true });
  await seed('lrn_observer_only', { observer: true, analysis: true, share: false });
  await seed('lrn_no_analysis', { observer: true, analysis: false, share: true });
});

describe('operator drill-down gate', () => {
  it('non-admins and requests without a learner get 404', async () => {
    expect((await view('lrn_both', learnerCtx('lrn_both'))).status).toBe(404);
    expect((await reportsRoute(routeContext({ env: env(), params: { id: 'lrn_both' } }))).status).toBe(404);
    expect((await summaryRoute(routeContext({ learner: learnerCtx('lrn_both'), env: env() }))).status).toBe(404);
    expect(await auditCount('lrn_both')).toBe(0);
  });

  it('is 404 for admins while the feature is off', async () => {
    expect((await view('lrn_both', admin, { INSIGHTS_MODE: 'off' })).status).toBe(404);
    expect((await summaryRoute(routeContext({ learner: admin, env: env({ INSIGHTS_MODE: 'off' }) }))).status).toBe(404);
    expect(await auditCount('lrn_both')).toBe(0);
  });

  it('share_operator without observer_consent, the reverse, analysis=0 and unknown ids are all 404 without audit', async () => {
    for (const id of ['lrn_share_only', 'lrn_observer_only', 'lrn_no_analysis', 'lrn_missing']) {
      const res = await view(id);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
      expect(await auditCount(id)).toBe(0);
    }
  });

  it('both consents on → 200 with reports only (no raw turn) and one audit row per view', async () => {
    const res = await view('lrn_both');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { learner: { id: string }; reports: Array<{ id: string; intent: { text: string } }> };
    expect(body.learner.id).toBe('lrn_both');
    expect(body.reports.map((r) => r.id)).toEqual(['irp_lrn_both']);
    expect(JSON.stringify(body)).not.toContain('RAW PROMPT');
    expect(JSON.stringify(body)).not.toContain('lrn_share_only');
    const audit = await db.prepare('SELECT learner_id, actor_id, action FROM insight_access_audit WHERE learner_id = ?').bind('lrn_both').all();
    expect(audit.results).toEqual([{ learner_id: 'lrn_both', actor_id: 'lrn_admin', action: 'view_reports' }]);
    await view('lrn_both');
    expect(await auditCount('lrn_both')).toBe(2);
  });

  it('revoking share_operator makes the very next call 404 with no new audit row', async () => {
    expect((await view('lrn_both')).status).toBe(200);
    await db.prepare('UPDATE insight_consents SET share_operator = 0 WHERE learner_id = ?').bind('lrn_both').run();
    expect((await view('lrn_both')).status).toBe(404);
    expect(await auditCount('lrn_both')).toBe(1);
  });

  it('revoking observer consent through the existing route also closes the drill-down at once', async () => {
    const request = new Request('https://unlock.zuey.me/api/v1/me/consent', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ observer: false }),
    });
    expect((await observerConsentRoute(routeContext({ learner: learnerCtx('lrn_both'), env: env(), request }))).status).toBe(200);
    expect((await view('lrn_both')).status).toBe(404);
  });

  it('a deleted learner is not viewable', async () => {
    await db.prepare(`UPDATE learners SET deleted_at = ? WHERE id = ?`).bind(T, 'lrn_both').run();
    expect(await viewLearnerReportsAsOperator(db, 'lrn_both', 'lrn_admin')).toBeNull();
  });
});

describe('summary: learners sharing detail', () => {
  it('lists only learners with observer_consent, share_operator and analysis', async () => {
    const res = await summaryRoute(routeContext({ learner: admin, env: env() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sharingLearners: Array<{ id: string; reports: number }> };
    expect(body.sharingLearners.map((l) => l.id)).toEqual(['lrn_both']);
    expect(body.sharingLearners[0].reports).toBe(1);
  });
});

describe('raw transcripts are never exposed to operators', () => {
  it('no operator query module references the queued turn payload', () => {
    for (const file of ['operator-insight-queries.ts', 'operator-access-audit.ts']) {
      const sql = readFileSync(join(__dirname, '../../src/lib/insights', file), 'utf8');
      expect(sql).not.toMatch(/payload_json/);
    }
  });
});
