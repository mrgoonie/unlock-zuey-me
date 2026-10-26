/**
 * insight_events queue against the real schema: readiness/debounce, lease claim, overflow release, lease
 * reclaim, stale-worker guard, backoff, dead-letter, deferral, stale sweep and the consent-guarded write.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import {
  claimWindow, completeWindow, deferWindow, failWindow, findReadyWindows, skipStaleEvents, skipWindow, type ReportRow,
} from '../../src/lib/insights/event-queue';

const NOW = new Date('2026-10-26T16:00:00.000Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const turn = { userPrompt: 'Lập kế hoạch cuối tuần', assistantFinal: 'Kế hoạch chi tiết cho bạn.', tools: [] };
let db: D1Database;

async function member(id: string, analysis = true) {
  await db.prepare(`INSERT INTO learners (id, kind, profile_json, created_at, updated_at) VALUES (?, 'member', '{}', ?, ?)`).bind(id, at(-5000), at(-5000)).run();
  await db.prepare(`INSERT INTO insight_consents (learner_id, analysis, updated_at) VALUES (?, ?, ?)`).bind(id, analysis ? 1 : 0, at(-5000)).run();
}

async function event(id: string, o: { learner?: string; session?: string; receivedMin?: number; nextMin?: number; endedMin?: number; status?: string;
  attempts?: number; bytes?: number; leaseId?: string; leaseUntilMin?: number } = {}) {
  const received = o.receivedMin ?? -10;
  await db.prepare(`INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json, payload_bytes,
      status, attempts, next_attempt_at, lease_id, lease_until, turn_ended_at, received_at)
    VALUES (?, ?, ?, ?, 'claude-code', '0.1.0', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, o.learner ?? 'lrn_a', `key_${id}`, o.session ?? 's1', JSON.stringify({ turn }), o.bytes ?? 200, o.status ?? 'pending', o.attempts ?? 0,
      at(o.nextMin ?? received + 5), o.leaseId ?? null, o.leaseUntilMin === undefined ? null : at(o.leaseUntilMin), at(o.endedMin ?? received), at(received))
    .run();
}

const row = (id: string) => db.prepare('SELECT * FROM insight_events WHERE id = ?').bind(id).first<Record<string, unknown>>();
const countReports = async () => (await db.prepare('SELECT COUNT(*) AS n FROM insight_reports').first<{ n: number }>())!.n;

const reportRow = (over: Partial<ReportRow> = {}): ReportRow => ({
  id: 'irp_1', learnerId: 'lrn_a', sessionRef: 's1', missionId: null, runId: null, reportJson: '{"relevant":true}', intentSummary: 'Mục tiêu',
  skillsJson: '[]', confidence: 0.7, hasProductObservation: false, sourceRuntime: 'claude-code', model: 'm', promptVersion: 1, eventCount: 1,
  windowStartedAt: at(-10), windowEndedAt: at(-10), createdAt: NOW.toISOString(), expiresAt: at(60 * 24 * 90), ...over,
});

beforeEach(async () => {
  db = createTestD1();
  await member('lrn_a');
});

describe('findReadyWindows', () => {
  it('waits for the debounce of every pending event, unless the window holds 5 fresh events', async () => {
    await event('e1', { receivedMin: -10 });
    await event('e2', { receivedMin: -2 }); // debounce until +3 min
    expect(await findReadyWindows(db, NOW, 10)).toEqual([]);
    expect(await findReadyWindows(db, new Date(Date.parse(at(4))), 10)).toEqual([{ learnerId: 'lrn_a', sessionRef: 's1' }]);
    for (const id of ['e3', 'e4', 'e5']) await event(id, { receivedMin: -1 });
    expect(await findReadyWindows(db, NOW, 10)).toHaveLength(1);
  });

  it('abrupt end: a single event with no follow-up becomes ready once the debounce has passed', async () => {
    await event('e1', { receivedMin: -4 });
    expect(await findReadyWindows(db, NOW, 10)).toEqual([]);
    expect(await findReadyWindows(db, new Date(Date.parse(at(2))), 10)).toHaveLength(1);
  });

  it('ignores learners without analysis consent or deleted learners', async () => {
    await member('lrn_b', false);
    await member('lrn_c');
    await db.prepare(`UPDATE learners SET deleted_at = ? WHERE id = 'lrn_c'`).bind(NOW.toISOString()).run();
    await event('b1', { learner: 'lrn_b' });
    await event('c1', { learner: 'lrn_c' });
    expect(await findReadyWindows(db, NOW, 10)).toEqual([]);
  });
});

describe('claimWindow', () => {
  it('leases the window, counts an attempt, keeps ≤ 10 events and releases the overflow untouched', async () => {
    for (let i = 0; i < 12; i++) await event(`e${String(i).padStart(2, '0')}`, { receivedMin: -20 + i });
    const win = await claimWindow(db, { learnerId: 'lrn_a', sessionRef: 's1' }, NOW, 'lease_1');
    expect(win!.events.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => `e${String(i).padStart(2, '0')}`));
    expect(win!.released).toBe(2);
    expect(await row('e00')).toMatchObject({ status: 'processing', lease_id: 'lease_1', attempts: 1, lease_until: at(5) });
    expect(await row('e11')).toMatchObject({ status: 'pending', lease_id: null, attempts: 0 });
  });

  it('caps a window at 48 KB but always keeps the first event', async () => {
    await event('e1', { receivedMin: -30, bytes: 30_000 });
    await event('e2', { receivedMin: -29, bytes: 30_000 });
    const win = await claimWindow(db, { learnerId: 'lrn_a', sessionRef: 's1' }, NOW);
    expect(win!.events.map((e) => e.id)).toEqual(['e1']);
    expect(win!.released).toBe(1);
  });

  it('returns null when nothing is claimable and leaves events in retry backoff alone', async () => {
    await event('e1', { attempts: 1, nextMin: 10 });
    expect(await claimWindow(db, { learnerId: 'lrn_a', sessionRef: 's1' }, NOW)).toBeNull();
  });

  it('reclaims an expired lease on the next tick; the stale worker can then change nothing', async () => {
    await event('e1', { status: 'processing', attempts: 1, leaseId: 'old_lease', leaseUntilMin: -1 });
    expect(await findReadyWindows(db, NOW, 10)).toHaveLength(1);
    const win = await claimWindow(db, { learnerId: 'lrn_a', sessionRef: 's1' }, NOW, 'new_lease');
    expect(win!.events).toHaveLength(1);
    expect(await row('e1')).toMatchObject({ lease_id: 'new_lease', attempts: 2 });

    expect(await completeWindow(db, 'old_lease', ['e1'], reportRow(), NOW)).toBe('lease_lost');
    expect(await countReports()).toBe(0);
    expect(await skipWindow(db, 'old_lease', 'trivial', NOW)).toBe(0);
    expect(await failWindow(db, 'old_lease', new Error('x'), NOW)).toEqual({ retried: 0, dead: 0 });
    expect(await row('e1')).toMatchObject({ status: 'processing', lease_id: 'new_lease' });
  });

  it('does not claim a live lease', async () => {
    await event('e1', { status: 'processing', attempts: 1, leaseId: 'live', leaseUntilMin: 3 });
    expect(await claimWindow(db, { learnerId: 'lrn_a', sessionRef: 's1' }, NOW)).toBeNull();
  });
});

describe('retry, dead-letter and deferral', () => {
  const claim = (t: Date, lease: string) => claimWindow(db, { learnerId: 'lrn_a', sessionRef: 's1' }, t, lease);

  it('backs off 15, 30, 60 min, then dead-letters on the 4th failure with the payload NULLed', async () => {
    await event('e1');
    let t = NOW;
    const expected = [15, 30, 60];
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await claim(t, `l${attempt}`)).not.toBeNull();
      expect(await failWindow(db, `l${attempt}`, new Error('model down'), t)).toEqual({ retried: 1, dead: 0 });
      const r = await row('e1');
      expect(r).toMatchObject({ status: 'pending', attempts: attempt, last_error: 'model down', lease_id: null });
      expect(r!.next_attempt_at).toBe(new Date(t.getTime() + expected[attempt - 1] * 60_000).toISOString());
      // Not claimable during the backoff.
      expect(await claim(new Date(t.getTime() + 60_000), `early${attempt}`)).toBeNull();
      t = new Date(Date.parse(r!.next_attempt_at as string));
    }
    expect(await claim(t, 'l4')).not.toBeNull();
    expect(await failWindow(db, 'l4', new Error('still down'), t)).toEqual({ retried: 0, dead: 1 });
    expect(await row('e1')).toMatchObject({ status: 'dead', attempts: 4, payload_json: null, last_error: 'still down', lease_id: null });
    expect(await findReadyWindows(db, new Date(t.getTime() + 86_400_000), 10)).toEqual([]);
  });

  it('a deferral (budget refusal or quota) gives the attempt back', async () => {
    await event('e1');
    await claim(NOW, 'l1');
    expect(await deferWindow(db, 'l1', new Date(Date.parse(at(15))))).toBe(1);
    expect(await row('e1')).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: at(15), lease_id: null });
  });

  it('skips with a reason and NULLs the payload, optionally for some events only', async () => {
    await event('e1');
    await event('e2');
    await claim(NOW, 'l1');
    expect(await skipWindow(db, 'l1', 'duplicate', NOW, ['e2'])).toBe(1);
    expect(await row('e2')).toMatchObject({ status: 'skipped', skip_reason: 'duplicate', payload_json: null });
    expect(await row('e1')).toMatchObject({ status: 'processing' });
  });
});

describe('skipStaleEvents', () => {
  it('marks events still waiting 48 h after receipt as skipped:stale with the payload NULLed', async () => {
    await event('old', { receivedMin: -48 * 60 - 1 });
    await event('young', { receivedMin: -47 * 60 });
    await event('old_lease', { receivedMin: -49 * 60, status: 'processing', attempts: 1, leaseId: 'x', leaseUntilMin: -1 });
    expect(await skipStaleEvents(db, NOW)).toBe(2);
    expect(await row('old')).toMatchObject({ status: 'skipped', skip_reason: 'stale', payload_json: null });
    expect(await row('old_lease')).toMatchObject({ status: 'skipped', skip_reason: 'stale', lease_id: null });
    expect(await row('young')).toMatchObject({ status: 'pending' });
  });
});

describe('completeWindow', () => {
  it('writes the report and closes the events as done with the payload NULLed, atomically', async () => {
    await event('e1');
    await claimWindow(db, { learnerId: 'lrn_a', sessionRef: 's1' }, NOW, 'l1');
    expect(await completeWindow(db, 'l1', ['e1'], reportRow(), NOW)).toBe('written');
    expect(await countReports()).toBe(1);
    expect(await row('e1')).toMatchObject({ status: 'done', payload_json: null, report_id: 'irp_1', processed_at: NOW.toISOString(), lease_id: null });
  });

  it('opt-out mid-flight: consent revoked after the claim → 0 reports and the window\'s events deleted', async () => {
    await event('e1');
    await event('e2');
    await claimWindow(db, { learnerId: 'lrn_a', sessionRef: 's1' }, NOW, 'l1');
    await db.prepare(`UPDATE insight_consents SET analysis = 0 WHERE learner_id = 'lrn_a'`).run();
    expect(await completeWindow(db, 'l1', ['e1', 'e2'], reportRow(), NOW)).toBe('revoked');
    expect(await countReports()).toBe(0);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM insight_events`).first<{ n: number }>())!.n).toBe(0);
  });
});
