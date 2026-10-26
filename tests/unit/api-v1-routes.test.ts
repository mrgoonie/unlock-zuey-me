import type { APIContext, APIRoute } from 'astro';
import { beforeEach, describe, expect, it } from 'vitest';
import { GET as getEvidence } from '../../src/pages/api/v1/evidence/[...key]';
import { POST as upload } from '../../src/pages/api/v1/evidence/upload';
import { POST as labResult } from '../../src/pages/api/v1/labs/[id]/result';
import { GET as getMe } from '../../src/pages/api/v1/me/index';
import { PATCH as patchProfile } from '../../src/pages/api/v1/me/profile';
import { POST as start } from '../../src/pages/api/v1/missions/[id]/start';
import { GET as recap } from '../../src/pages/api/v1/recap';
import { PATCH as patchAnswers } from '../../src/pages/api/v1/runs/[id]/answers';
import { GET as getRun } from '../../src/pages/api/v1/runs/[id]/index';
import type { LearnerContext } from '../../src/lib/learning/types';
import { fakeEnv, seedLearner, type FakeEnv } from './learning-fake-env';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let env: FakeEnv;
let alice: LearnerContext;
let bob: LearnerContext;

function call(route: APIRoute, opts: { learner?: LearnerContext; method?: string; path?: string; params?: Record<string, string>; body?: unknown; form?: FormData }) {
  const url = new URL(`https://unlock.zuey.me${opts.path ?? '/api/v1/x'}`);
  const init: RequestInit = { method: opts.method ?? 'GET' };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    init.headers = { 'content-type': 'application/json' };
  }
  const ctx = { request: new Request(url, init), url, params: opts.params ?? {}, locals: { learner: opts.learner, runtime: { env } } };
  return route(ctx as unknown as APIContext) as Promise<Response>;
}

/** JSON body for structural assertions; `any` is confined to test assertions on API responses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

beforeEach(async () => {
  env = fakeEnv();
  alice = await seedLearner(env.DB, 'lrn_alice');
  bob = await seedLearner(env.DB, 'lrn_bob');
});

describe('/api/v1 routes', () => {
  it('requires a learner from locals', async () => {
    const res = await call(getMe, {});
    expect(res.status).toBe(401);
    expect((await read(res)).error.code).toBe('unauthorized');
  });

  it('GET /me returns learner and progress', async () => {
    const body = await read(call(getMe, { learner: alice }));
    expect(body.learner.id).toBe(alice.id);
    expect(body.progress).toMatchObject({ xp: 0, level: { id: 'L0' }, completedMissions: [] });
  });

  it('start → answers with stale rev returns 409 with the current run; foreign run is 404', async () => {
    const { run } = await read(call(start, { learner: alice, method: 'POST', params: { id: 'plan-weekend' } }));
    const ok = await call(patchAnswers, { learner: alice, method: 'PATCH', params: { id: run.id }, body: { stepId: 'constraints', answers: { goal: 'Nghỉ ngơi' }, rev: 0 } });
    expect(ok.status).toBe(200);
    const stale = await call(patchAnswers, { learner: alice, method: 'PATCH', params: { id: run.id }, body: { stepId: 'constraints', answers: { goal: 'x' }, rev: 0 } });
    expect(stale.status).toBe(409);
    const conflict = await read(stale);
    expect(conflict.error.code).toBe('conflict');
    expect(conflict.run.rev).toBe(1);
    expect((await call(getRun, { learner: bob, params: { id: run.id } })).status).toBe(404);
    const detail = await read(call(getRun, { learner: alice, params: { id: run.id } }));
    expect(detail.mission.id).toBe('plan-weekend');
    expect(detail.evaluation).toBeNull();
    expect((await call(patchAnswers, { learner: alice, method: 'PATCH', params: { id: run.id }, body: '{bad json' })).status).toBe(400);
  });

  it('PATCH /me/profile accepts sound, reducedMotion and timezone', async () => {
    const res = await call(patchProfile, { learner: alice, method: 'PATCH', body: { profile: { sound: false, reducedMotion: true, timezone: 'Asia/Saigon' } } });
    expect(res.status).toBe(200);
    expect((await read(res)).learner.profile).toEqual({ sound: false, reducedMotion: true, timezone: 'Asia/Saigon' });
    expect((await call(patchProfile, { learner: alice, method: 'PATCH', body: { learnerId: 'lrn_bob' } })).status).toBe(400);
  });

  it('POST /labs/:id/result returns labsDone', async () => {
    const res = await call(labResult, { learner: alice, method: 'POST', params: { id: 'hallucination-detective' }, body: { result: { score: 3, total: 4, calibration: 0.8 } } });
    expect(await read(res)).toEqual({ labsDone: ['hallucination-detective'], newBadges: [] });
  });

  it('GET /recap validates the period', async () => {
    expect((await call(recap, { learner: alice, path: '/api/v1/recap?period=year' })).status).toBe(400);
    expect((await call(recap, { learner: alice, path: '/api/v1/recap?period=week' })).status).toBe(200);
  });
});

describe('evidence upload and access', () => {
  const uploadFile = async (learner: LearnerContext, bytes: Uint8Array<ArrayBuffer>) => {
    const form = new FormData();
    form.set('file', new File([bytes], 'shot.png', { type: 'image/png' }));
    return call(upload, { learner, method: 'POST', form });
  };

  it('accepts real images only (sniffed bytes, not the declared type)', async () => {
    const bad = await uploadFile(alice, new TextEncoder().encode('<script>alert(1)</script>'));
    expect(bad.status).toBe(400);
    const good = await uploadFile(alice, PNG);
    const { key } = await read(good);
    expect(key).toMatch(/^ev\/lrn_alice\/img_[a-z0-9]+\.png$/);
  });

  it('serves the owner, hides from others, and lets admins in only with live consent', async () => {
    const { key } = await read(uploadFile(alice, PNG));
    const get = (learner: LearnerContext) => call(getEvidence, { learner, params: { key } });
    const own = await get(alice);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('image/png');
    expect(own.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(PNG);
    expect((await get(bob)).status).toBe(404);

    const admin = await seedLearner(env.DB, 'lrn_admin', { isAdmin: true });
    expect((await get(admin)).status).toBe(404);
    await env.DB.prepare('UPDATE learners SET observer_consent = 1 WHERE id = ?').bind(alice.id).run();
    expect((await get(admin)).status).toBe(200);
    await env.DB.prepare('UPDATE learners SET observer_consent = 0 WHERE id = ?').bind(alice.id).run();
    expect((await get(admin)).status).toBe(404);
    expect((await call(getEvidence, { learner: alice, params: { key: '../../etc/passwd' } })).status).toBe(404);
    // fully encoded keys (`ev%2F…`) resolve too; malformed escapes are 404, not 500
    expect((await call(getEvidence, { learner: alice, params: { key: encodeURIComponent(key) } })).status).toBe(200);
    expect((await call(getEvidence, { learner: alice, params: { key: '%E0%A4%A' } })).status).toBe(404);
  });
});
