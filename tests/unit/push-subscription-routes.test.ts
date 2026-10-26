import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { POST as subscribeRoute } from '../../src/pages/api/v1/push/subscribe';
import { POST as unsubscribeRoute } from '../../src/pages/api/v1/push/unsubscribe';
import { PATCH as settingsRoute } from '../../src/pages/api/v1/push/settings';
import { GET as publicKeyRoute } from '../../src/pages/api/v1/push/public-key';
import { isAllowedPushEndpoint } from '../../src/lib/push/subscription-store';
import { learnerCtx, routeContext } from './observer-seed-fixtures';

let db: D1Database;
const T = '2026-10-01T00:00:00.000Z';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';
const subscription = { endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: 'BOr1x_-abcdefgh', auth: 'authsecret12' } };

const req = (method: string, body: unknown) => new Request('https://unlock.zuey.me/api/v1/push/x', {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const call = (route: (c: never) => Response | Promise<Response>, learnerId: string, method: string, body: unknown) =>
  route(routeContext({ learner: learnerCtx(learnerId), env: { DB: db }, request: req(method, body) }));
type StatusBody = { status: { devices: number; enabled: boolean; remindTime: string; timezone: string } };

beforeEach(async () => {
  db = createTestD1();
  for (const id of ['lrn_a', 'lrn_b']) {
    await db.prepare(`INSERT INTO learners (id, kind, created_at, updated_at) VALUES (?, 'guest', ?, ?)`).bind(id, T, T).run();
  }
});

describe('push subscription routes', () => {
  it('subscribes, updates settings, and unsubscribes idempotently', async () => {
    let res = await call(subscribeRoute, 'lrn_a', 'POST', { subscription, remindTime: '07:30', timezone: 'Asia/Saigon' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as StatusBody).status).toMatchObject({ devices: 1, enabled: true, remindTime: '07:30' });

    res = await call(settingsRoute, 'lrn_a', 'PATCH', { enabled: false, remindTime: '21:00' });
    expect(((await res.json()) as StatusBody).status).toMatchObject({ enabled: false, remindTime: '21:00' });

    res = await call(unsubscribeRoute, 'lrn_a', 'POST', { endpoint: ENDPOINT });
    expect(((await res.json()) as StatusBody).status.devices).toBe(0);
    res = await call(unsubscribeRoute, 'lrn_a', 'POST', { endpoint: ENDPOINT });
    expect(res.status).toBe(200);
    expect((await call(settingsRoute, 'lrn_a', 'PATCH', { enabled: true })).status).toBe(404);
  });

  it('moves a re-subscribed device to the current learner and never lets others remove it', async () => {
    await call(subscribeRoute, 'lrn_a', 'POST', { subscription });
    await call(subscribeRoute, 'lrn_b', 'POST', { subscription });
    expect(await db.prepare('SELECT learner_id FROM push_subscriptions').first('learner_id')).toBe('lrn_b');
    await call(unsubscribeRoute, 'lrn_a', 'POST', { endpoint: ENDPOINT });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first('n')).toBe(1);
  });

  it('rejects invalid time, timezone and non-push endpoints', async () => {
    for (const body of [
      { subscription, remindTime: '25:00' },
      { subscription, timezone: 'Not/AZone' },
      { subscription: { ...subscription, endpoint: 'https://evil.example.com/hook' } },
      { subscription: { ...subscription, endpoint: 'http://fcm.googleapis.com/x' } },
    ]) {
      expect((await call(subscribeRoute, 'lrn_a', 'POST', body)).status).toBe(400);
    }
    expect(isAllowedPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false);
  });

  it('serves the VAPID public key or 503 when unset', async () => {
    const ok = await publicKeyRoute(routeContext({ env: { VAPID_PUBLIC_KEY: 'BPUB' } }));
    expect(await ok.json()).toEqual({ key: 'BPUB' });
    expect((await publicKeyRoute(routeContext({ env: {} }))).status).toBe(503);
  });
});
