import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { MAX_FAILURES, sendDueReminders } from '../../src/lib/push/reminder-job';
import { decryptPushBody, makeBrowserSubscription, makeVapidKeys } from './push-test-crypto';

const NOW = new Date('2026-10-26T13:05:00Z'); // 20:05 in Asia/Saigon
const T = '2026-10-01T00:00:00.000Z';

type Sub = Awaited<ReturnType<typeof makeBrowserSubscription>>;
let db: D1Database;
let env: Parameters<typeof sendDueReminders>[0];
let browser: Sub;

async function addLearner(id: string) {
  await db.prepare(`INSERT INTO learners (id, kind, created_at, updated_at) VALUES (?, 'guest', ?, ?)`).bind(id, T, T).run();
}
async function addSub(id: string, learnerId: string, remind = '20:00', tz = 'Asia/Saigon', endpoint = `https://fcm.googleapis.com/fcm/send/${id}`) {
  await db.prepare(`INSERT INTO push_subscriptions (id, learner_id, endpoint, p256dh, auth, remind_time, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, learnerId, endpoint, browser.p256dh, browser.auth, remind, tz, T).run();
}
const sub = (id: string) => db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').bind(id).first<Record<string, unknown>>();
const okFetch = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 201 }));

beforeEach(async () => {
  db = createTestD1();
  const vapid = await makeVapidKeys();
  browser = await makeBrowserSubscription('https://fcm.googleapis.com/fcm/send/x');
  env = { DB: db, PUBLIC_SITE_URL: 'https://unlock.zuey.me', VAPID_SUBJECT: 'mailto:t@example.com', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
  await addLearner('lrn_a');
});

afterEach(() => vi.restoreAllMocks());

describe('sendDueReminders', () => {
  it('sends a due reminder once per local day and records push.sent', async () => {
    await addSub('psh_a', 'lrn_a');
    const fetchFn = okFetch();
    expect(await sendDueReminders(env, { now: NOW, fetchFn })).toMatchObject({ sent: 1 });
    expect((await sub('psh_a'))?.last_sent_day).toBe('2026-10-26');
    // A second run in the same window (or a retried cron) sends nothing.
    expect(await sendDueReminders(env, { now: new Date('2026-10-26T13:10:00Z'), fetchFn })).toMatchObject({ sent: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const evt = await db.prepare(`SELECT name FROM events WHERE learner_id = 'lrn_a'`).first<{ name: string }>();
    expect(evt?.name).toBe('push.sent');
  });

  it('mentions and links the in-progress mission', async () => {
    await addSub('psh_a', 'lrn_a');
    await db.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, started_at, updated_at) VALUES ('run_1', 'lrn_a', 'plan-weekend', 1, 'started', ?, ?)`).bind(T, T).run();
    const fetchFn = okFetch();
    await sendDueReminders(env, { now: NOW, fetchFn, missionTitle: () => 'Kế hoạch cuối tuần' });
    const payload = JSON.parse(await decryptPushBody(fetchFn.mock.calls[0][1].body as Uint8Array<ArrayBuffer>, browser));
    expect(payload.notification.navigate).toBe('https://unlock.zuey.me/missions/plan-weekend');
    expect(payload.notification.body).toContain('Kế hoạch cuối tuần');
  });

  it('skips subscriptions outside the window, in other zones, or of learners active today', async () => {
    await addLearner('lrn_b');
    await addLearner('lrn_c');
    await addSub('psh_a', 'lrn_a', '20:30');
    await addSub('psh_b', 'lrn_b', '20:00', 'Europe/Paris');
    await addSub('psh_c', 'lrn_c');
    await db.prepare(`INSERT INTO activity_days (learner_id, day) VALUES ('lrn_c', '2026-10-26')`).run();
    const fetchFn = okFetch();
    expect(await sendDueReminders(env, { now: NOW, fetchFn })).toMatchObject({ sent: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('deletes subscriptions the push service reports as gone (404/410)', async () => {
    await addSub('psh_a', 'lrn_a');
    await addSub('psh_b', 'lrn_a', '20:00', 'Asia/Saigon', 'https://fcm.googleapis.com/fcm/send/b');
    let n = 0;
    const fetchFn = vi.fn(async () => new Response(null, { status: n++ === 0 ? 410 : 404 }));
    expect(await sendDueReminders(env, { now: NOW, fetchFn })).toMatchObject({ removed: 2 });
    expect(await sub('psh_a')).toBeNull();
    expect(await sub('psh_b')).toBeNull();
  });

  it('counts failures and disables after the limit', async () => {
    await addSub('psh_a', 'lrn_a');
    const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
    for (let day = 0; day < MAX_FAILURES; day++) {
      await sendDueReminders(env, { now: new Date(NOW.getTime() + day * 86_400_000), fetchFn });
    }
    const row = await sub('psh_a');
    expect(row?.failures).toBe(MAX_FAILURES);
    expect(row?.enabled).toBe(0);
    await sendDueReminders(env, { now: new Date(NOW.getTime() + 9 * 86_400_000), fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(MAX_FAILURES);
  });

  it('survives network errors and works through every batch', async () => {
    for (const id of ['psh_1', 'psh_2', 'psh_3']) await addSub(id, 'lrn_a', '20:00', 'Asia/Saigon', `https://fcm.googleapis.com/fcm/send/${id}`);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchFn = vi.fn(async () => { throw new Error('network down'); });
    expect(await sendDueReminders(env, { now: NOW, fetchFn, batchSize: 2 })).toMatchObject({ failed: 3, deferred: false });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('delivers far more than one batch in a single window', async () => {
    for (let i = 0; i < 250; i++) {
      const id = `psh_${String(i).padStart(3, '0')}`;
      await addSub(id, 'lrn_a', '20:00', 'Asia/Saigon', `https://fcm.googleapis.com/fcm/send/${id}`);
    }
    const fetchFn = okFetch();
    expect(await sendDueReminders(env, { now: NOW, fetchFn })).toMatchObject({ sent: 250, deferred: false });
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE last_sent_day IS NULL`).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('stops at the run budget and the next run catches up through the look-back', async () => {
    for (const id of ['psh_1', 'psh_2', 'psh_3']) await addSub(id, 'lrn_a', '20:00', 'Asia/Saigon', `https://fcm.googleapis.com/fcm/send/${id}`);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchFn = okFetch();
    expect(await sendDueReminders(env, { now: NOW, fetchFn, batchSize: 2, maxSends: 2 })).toMatchObject({ sent: 2, deferred: true });
    // Next cron tick (20:20 local) is a new quarter hour, but 20:00 is still inside the look-back.
    expect(await sendDueReminders(env, { now: new Date('2026-10-26T13:20:00Z'), fetchFn })).toMatchObject({ sent: 1, deferred: false });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('stops when the time budget is spent', async () => {
    await addSub('psh_a', 'lrn_a');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchFn = okFetch();
    let t = 0;
    const clock = () => (t += 1000);
    expect(await sendDueReminders(env, { now: NOW, fetchFn, clock, timeBudgetMs: 500 })).toMatchObject({ sent: 0, deferred: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not send reminders older than the look-back window', async () => {
    await addSub('psh_a', 'lrn_a', '18:30');
    const fetchFn = okFetch();
    expect(await sendDueReminders(env, { now: NOW, fetchFn })).toMatchObject({ sent: 0 });
  });

  it('does nothing without VAPID keys', async () => {
    await addSub('psh_a', 'lrn_a');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchFn = okFetch();
    expect(await sendDueReminders({ ...env, VAPID_PRIVATE_KEY: undefined }, { now: NOW, fetchFn })).toMatchObject({ sent: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
