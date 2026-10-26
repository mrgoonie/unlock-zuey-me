import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { GET as listRoute } from '../../src/pages/api/v1/admin/learners/index';
import { GET as detailRoute } from '../../src/pages/api/v1/admin/learners/[id]/index';
import { GET as eventsRoute } from '../../src/pages/api/v1/admin/learners/[id]/events';
import { PATCH as consentRoute } from '../../src/pages/api/v1/me/consent';
import { getLearnerDetail, getTimelinePage, listObservedLearners } from '../../src/lib/observer/queries';
import { learnerCtx, routeContext, seedLearner } from './observer-seed-fixtures';

let db: D1Database;
const admin = learnerCtx('lrn_admin', { isAdmin: true });
const call = (route: (ctx: never) => Response | Promise<Response>, learner = admin, params: Record<string, string> = {}) =>
  route(routeContext({ learner, env: { DB: db }, params }));

async function setConsent(learnerId: string, observer: boolean) {
  const request = new Request('https://unlock.zuey.me/api/v1/me/consent', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ observer }),
  });
  const res = await consentRoute(routeContext({ learner: learnerCtx(learnerId), env: { DB: db }, request }));
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  db = createTestD1();
  await seedLearner(db, 'lrn_wife', { consent: true, name: 'Vợ' });
  await seedLearner(db, 'lrn_other', { consent: false, name: 'Người khác' });
});

describe('observer admin gate', () => {
  it('returns 404 (not 403) to non-admins and to requests without a learner', async () => {
    const learner = learnerCtx('lrn_wife');
    for (const res of [
      await call(listRoute, learner),
      await call(detailRoute, learner, { id: 'lrn_wife' }),
      await call(eventsRoute, learner, { id: 'lrn_wife' }),
      await listRoute(routeContext({ env: { DB: db } })),
    ]) {
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    }
  });
});

describe('observer consent gate', () => {
  it('lists only consenting learners', async () => {
    const res = await call(listRoute);
    const { learners } = (await res.json()) as { learners: Array<{ id: string; xp: number; missionsDone: number }> };
    expect(learners.map((l) => l.id)).toEqual(['lrn_wife']);
    expect(learners[0]).toMatchObject({ xp: 50, missionsDone: 1 });
  });

  it('never shows a non-consenting learner, even by direct id', async () => {
    expect((await call(detailRoute, admin, { id: 'lrn_other' })).status).toBe(404);
    expect((await call(eventsRoute, admin, { id: 'lrn_other' })).status).toBe(404);
    expect(await getLearnerDetail(db, 'lrn_other')).toBeNull();
    expect(await getTimelinePage(db, 'lrn_other')).toBeNull();
    expect((await call(detailRoute, admin, { id: 'lrn_missing' })).status).toBe(404);
  });

  it('shows the consenting learner journey', async () => {
    const res = await call(detailRoute, admin, { id: 'lrn_wife' });
    expect(res.status).toBe(200);
    const d = (await res.json()) as Awaited<ReturnType<typeof getLearnerDetail>>;
    expect(d?.timeline.events.map((e) => e.name)).toEqual(['mission.step_viewed', 'mission.started']);
    expect(d?.funnel[0]).toMatchObject({ missionId: 'plan-weekend', started: 1, submitted: 1, passed: 1 });
    expect(d?.funnel[0].steps.find((s) => s.stepId === 'intro')?.viewed).toBe(1);
    expect(d?.hints[0]).toMatchObject({ hintsUsed: 3, hintMaxLevel: 2 });
    expect(d?.evaluations[0]).toMatchObject({ score: 0.84, confidence: 90 });
    expect(d?.evaluations[0].criteria[0].label).toBe('Làm rõ ràng buộc');
    expect(d?.competencies).toEqual([{ competency: 'verify', score: 0.6, evidenceCount: 1 }]);
    expect(d?.firstWin.msFromFirstStart).toBe(14 * 60_000);
    expect(d?.evidence[0].imageKeys).toEqual(['ev/lrn_wife/a.png']);
    expect(d?.coach[0].content).toBe('Câu hỏi của lrn_wife');
    // Nothing from the other learner leaks into the view.
    expect(JSON.stringify(d)).not.toContain('lrn_other');
  });

  it('hides everything on the very next query after consent is revoked, and shows it again when re-granted', async () => {
    expect((await call(detailRoute, admin, { id: 'lrn_wife' })).status).toBe(200);
    await setConsent('lrn_wife', false);
    expect((await call(detailRoute, admin, { id: 'lrn_wife' })).status).toBe(404);
    expect((await call(eventsRoute, admin, { id: 'lrn_wife' })).status).toBe(404);
    expect(await listObservedLearners(db)).toEqual([]);
    const evt = await db.prepare(`SELECT name FROM events WHERE learner_id = 'lrn_wife' ORDER BY occurred_at DESC LIMIT 1`).first<{ name: string }>();
    expect(evt?.name).toBe('consent.revoked');

    await setConsent('lrn_wife', true);
    expect((await call(detailRoute, admin, { id: 'lrn_wife' })).status).toBe(200);
  });

  it('paginates the timeline with a cursor', async () => {
    const first = await getTimelinePage(db, 'lrn_wife', { limit: 1 });
    expect(first?.events).toHaveLength(1);
    expect(first?.nextCursor).toBeTruthy();
    const second = await getTimelinePage(db, 'lrn_wife', { limit: 1, cursor: first?.nextCursor });
    expect(second?.events[0].name).toBe('mission.started');
    expect(second?.nextCursor).toBeNull();
  });
});
