import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_LAB_RESULTS_PER_DAY, recordLabResult } from '../../src/lib/learning/labs-and-concepts';
import { exportLearnerData, exportLearnerTablePage, EXPORT_LIMITS } from '../../src/lib/privacy/export-learner-data';
import { MAX_SUBSCRIPTIONS_PER_LEARNER, subscribeSchema, upsertSubscription } from '../../src/lib/push/subscription-store';
import { GET as exportRoute } from '../../src/pages/api/v1/me/export';
import { fakeEnv, seedLearner, type FakeEnv } from './learning-fake-env';
import { learnerCtx, routeContext } from './observer-seed-fixtures';

const NOW = new Date('2026-10-26T03:00:00Z');
let env: FakeEnv;

beforeEach(() => {
  env = fakeEnv();
});

const count = async (sql: string, ...binds: unknown[]) => Number((await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0);

describe('lab result cap', () => {
  it('stores at most MAX_LAB_RESULTS_PER_DAY rows per lab per day and keeps answering', async () => {
    const alice = await seedLearner(env.DB, 'lrn_alice');
    const deps = { env, now: () => NOW };
    for (let i = 0; i < MAX_LAB_RESULTS_PER_DAY + 5; i++) {
      const r = await recordLabResult(deps, alice, 'context-lab', { score: 1, total: 2 });
      expect(r.labsDone).toContain('context-lab');
    }
    expect(await count(`SELECT COUNT(*) AS n FROM lab_runs WHERE learner_id = 'lrn_alice'`)).toBe(MAX_LAB_RESULTS_PER_DAY);
    expect(await count(`SELECT COUNT(*) AS n FROM events WHERE name = 'lab.completed'`)).toBe(MAX_LAB_RESULTS_PER_DAY);
    // Another lab and the next UTC day have their own allowance.
    await recordLabResult(deps, alice, 'token-predictor', { score: 1, total: 2 });
    await recordLabResult({ env, now: () => new Date(NOW.getTime() + 86_400_000) }, alice, 'context-lab', { score: 1, total: 2 });
    expect(await count(`SELECT COUNT(*) AS n FROM lab_runs WHERE learner_id = 'lrn_alice'`)).toBe(MAX_LAB_RESULTS_PER_DAY + 2);
  });
});

describe('push subscription cap', () => {
  const input = (device: number) => subscribeSchema.parse({
    subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/device-${device}`, keys: { p256dh: 'BOr1x_-abcdefgh', auth: 'authsecret12' } },
  });

  it('keeps the newest devices and replaces the oldest', async () => {
    await seedLearner(env.DB, 'lrn_alice');
    await seedLearner(env.DB, 'lrn_bob');
    await upsertSubscription(env.DB, 'lrn_bob', input(99), NOW);
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_LEARNER + 2; i++) {
      await upsertSubscription(env.DB, 'lrn_alice', input(i), new Date(NOW.getTime() + i * 1000));
    }
    const rows = await env.DB.prepare(`SELECT endpoint FROM push_subscriptions WHERE learner_id = 'lrn_alice' ORDER BY created_at`).all<{ endpoint: string }>();
    expect(rows.results.map((r) => r.endpoint.split('-').pop())).toEqual(['2', '3', '4', '5', '6']);
    // Re-subscribing an old device makes it the newest instead of evicting it.
    await upsertSubscription(env.DB, 'lrn_alice', input(2), new Date(NOW.getTime() + 60_000));
    await upsertSubscription(env.DB, 'lrn_alice', input(7), new Date(NOW.getTime() + 61_000));
    const after = await env.DB.prepare(`SELECT endpoint FROM push_subscriptions WHERE learner_id = 'lrn_alice' ORDER BY created_at`).all<{ endpoint: string }>();
    expect(after.results.map((r) => r.endpoint.split('-').pop())).toEqual(['4', '5', '6', '2', '7']);
    // Other learners are untouched.
    expect(await count(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE learner_id = 'lrn_bob'`)).toBe(1);
  });
});

describe('bounded export', () => {
  async function seedEvents(learnerId: string, n: number, propsChars = 10) {
    const stmts = Array.from({ length: n }, (_, i) => env.DB.prepare(
      `INSERT INTO events (id, learner_id, name, props_json, occurred_at) VALUES (?, ?, 'mission.step_viewed', ?, ?)`,
    ).bind(`evt_${learnerId}_${i}`, learnerId, JSON.stringify({ stepId: 'x'.repeat(propsChars), i }), NOW.toISOString()));
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  }

  it('caps rows per table and pages through the rest without gaps or duplicates', async () => {
    await seedLearner(env.DB, 'lrn_alice');
    await seedLearner(env.DB, 'lrn_bob');
    const total = EXPORT_LIMITS.rowsPerTable * 2 + 5;
    await seedEvents('lrn_alice', total);
    await seedEvents('lrn_bob', 10);

    const data = await exportLearnerData(env.DB, undefined, 'lrn_alice');
    expect(data.tables.events).toHaveLength(EXPORT_LIMITS.rowsPerTable);
    expect(Object.keys(data.continuation)).toEqual(['events']);
    expect(data.continuation.events.url).toMatch(/^\/api\/v1\/me\/export\?table=events&after=\d+$/);
    expect(data.note).toBeTruthy();

    const seen = data.tables.events.map((r) => r.id as string);
    let next = data.continuation.events as { after: number } | null;
    while (next) {
      const page = await exportLearnerTablePage(env.DB, 'lrn_alice', 'events', next.after);
      seen.push(...page.rows.map((r) => r.id as string));
      expect(page.rows.every((r) => r.learner_id === 'lrn_alice')).toBe(true);
      next = page.next;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen.some((id) => id.includes('lrn_bob'))).toBe(false);
  });

  it('stops at the byte budget and is complete when the data is small', async () => {
    await seedLearner(env.DB, 'lrn_alice');
    const small = await exportLearnerData(env.DB, undefined, 'lrn_alice');
    expect(small.continuation).toEqual({});
    expect(small.note).toBeUndefined();

    // ~20 KB per event: 600 rows exceed the 8 MB budget before the row cap.
    await seedEvents('lrn_alice', 600, 20_000);
    const big = await exportLearnerData(env.DB, undefined, 'lrn_alice');
    const bytes = JSON.stringify(big.tables).length;
    expect(bytes).toBeLessThan(EXPORT_LIMITS.maxBytes + 64 * 1024);
    expect(big.tables.events.length).toBeLessThan(600);
    expect(big.continuation.events).toBeDefined();
  });

  it('rejects unknown tables and bad cursors on the page endpoint', async () => {
    await seedLearner(env.DB, 'lrn_alice');
    const ctx = (url: string) => routeContext({ learner: learnerCtx('lrn_alice'), env: { DB: env.DB }, url });
    expect((await exportRoute(ctx('https://unlock.zuey.me/api/v1/me/export?table=learners'))).status).toBe(400);
    expect((await exportRoute(ctx('https://unlock.zuey.me/api/v1/me/export?table=events&after=-1'))).status).toBe(400);
    const ok = await exportRoute(ctx('https://unlock.zuey.me/api/v1/me/export?table=events&after=0'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ format: 'ai-unlocked-export-page', table: 'events', next: null });
  });
});
