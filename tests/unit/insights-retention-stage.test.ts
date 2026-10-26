/**
 * Insights retention stage: report TTL, dead/processed payloads NULLed, 48 h pending → skipped:stale,
 * 7-day queue retention, orphan signal pruning, LIMIT batches and budget charging.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { runRetentionStage } from '../../src/lib/insights/retention-stage';
import { NOW, seedMember } from './insights-ingest-fixtures';

let db: D1Database;
let env: Env;
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

async function event(id: string, status: string, receivedHoursAgo: number, opts: { processedHoursAgo?: number; payload?: string | null } = {}) {
  await db.prepare(`INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json,
      payload_bytes, status, next_attempt_at, turn_ended_at, received_at, processed_at)
    VALUES (?, 'lrn_a', ?, 's', 'claude-code', '0.1.0', ?, 10, ?, ?, ?, ?, ?)`).bind(
    id, id, opts.payload === undefined ? '{"v":1}' : opts.payload, status, ago(receivedHoursAgo), ago(receivedHoursAgo), ago(receivedHoursAgo),
    opts.processedHoursAgo === undefined ? null : ago(opts.processedHoursAgo),
  ).run();
}

async function report(id: string, expiresAt: string) {
  await db.prepare(`INSERT INTO insight_reports (id, learner_id, session_ref, report_json, intent_summary, confidence, source_runtime, model,
      prompt_version, event_count, window_started_at, window_ended_at, created_at, expires_at)
    VALUES (?, 'lrn_a', 's', '{}', 'x', 0.5, 'claude-code', 'm', 1, 1, ?, ?, ?, ?)`).bind(id, ago(1), ago(1), ago(1), expiresAt).run();
}

async function signal(id: string) {
  await db.prepare(`INSERT INTO insight_signals (id, fingerprint, category, area, title, first_seen_at, last_seen_at, created_at)
    VALUES (?, ?, 'ux', 'hints', 't', ?, ?, ?)`).bind(id, `fp_${id}`, ago(1), ago(1), ago(1)).run();
}

const rows = async (sql: string) => (await db.prepare(sql).all<Record<string, unknown>>()).results;

beforeEach(async () => {
  db = createTestD1();
  env = { DB: db } as unknown as Env;
  await seedMember(db, 'lrn_a');
});

describe('insights retention stage', () => {
  it('applies TTLs, nulls payloads, stales old pending rows and prunes orphan signals', async () => {
    await report('irp_old', ago(1));
    await report('irp_live', later(24));
    await signal('sig_evidence_gone');
    await signal('sig_live');
    await signal('sig_proposed');
    await db.prepare(`INSERT INTO insight_signal_evidence (signal_id, report_id, abstract_evidence, confidence, created_at) VALUES ('sig_evidence_gone', 'irp_old', 'e', 0.5, ?)`).bind(ago(1)).run();
    await db.prepare(`INSERT INTO insight_signal_evidence (signal_id, report_id, abstract_evidence, confidence, created_at) VALUES ('sig_live', 'irp_live', 'e', 0.5, ?)`).bind(ago(1)).run();
    await db.prepare(`INSERT INTO insight_proposals (id, signal_id, status, risk, gate_json, draft_json, created_at, updated_at)
      VALUES ('prp_1', 'sig_proposed', 'proposed', 'low', '{}', '{}', ?, ?)`).bind(ago(1), ago(1)).run();

    await event('iev_pending_fresh', 'pending', 47);
    await event('iev_pending_stale', 'pending', 49);
    await event('iev_dead_recent', 'dead', 30, { processedHoursAgo: 2 });
    await event('iev_done_old', 'done', 8 * 24, { processedHoursAgo: 8 * 24, payload: null });
    await event('iev_skipped_recent', 'skipped', 3 * 24, { processedHoursAgo: 3 * 24, payload: null });
    await event('iev_processing', 'processing', 1);

    const budget = createCronBudget({ d1Queries: 100, subrequests: 1000 });
    const result = await runRetentionStage(env, budget, NOW);
    expect(result).toEqual({ reportsDeleted: 1, eventsStaled: 1, payloadsNulled: 1, eventsDeleted: 1, signalsDeleted: 1, deferred: false });
    expect(budget.remainingD1Queries()).toBe(95);
    expect(budget.remainingSubrequests()).toBe(995);

    expect((await rows(`SELECT id FROM insight_reports`)).map((r) => r.id)).toEqual(['irp_live']);
    expect((await rows(`SELECT id FROM insight_signals ORDER BY id`)).map((r) => r.id)).toEqual(['sig_live', 'sig_proposed']);
    expect(await rows(`SELECT id, status, skip_reason, payload_json IS NULL AS nulled FROM insight_events ORDER BY id`)).toEqual([
      { id: 'iev_dead_recent', status: 'dead', skip_reason: null, nulled: 1 },
      { id: 'iev_pending_fresh', status: 'pending', skip_reason: null, nulled: 0 },
      { id: 'iev_pending_stale', status: 'skipped', skip_reason: 'stale', nulled: 1 },
      { id: 'iev_processing', status: 'processing', skip_reason: null, nulled: 0 },
      { id: 'iev_skipped_recent', status: 'skipped', skip_reason: null, nulled: 1 },
    ]);
    expect((await db.prepare(`SELECT processed_at FROM insight_events WHERE id = 'iev_pending_stale'`).first('processed_at'))).toBe(NOW.toISOString());

    // A second run finds nothing more to do.
    expect(await runRetentionStage(env, budget, NOW)).toMatchObject({ reportsDeleted: 0, eventsStaled: 0, payloadsNulled: 0, eventsDeleted: 0, signalsDeleted: 0 });
  });

  it('stops when the budget cannot afford the next step and resumes next tick', async () => {
    await event('iev_pending_stale', 'pending', 49);
    await event('iev_done_old', 'done', 9 * 24, { processedHoursAgo: 9 * 24, payload: null });
    const tight = createCronBudget({ d1Queries: 2, subrequests: 1000 });
    const first = await runRetentionStage(env, tight, NOW);
    expect(first).toMatchObject({ eventsStaled: 1, eventsDeleted: 0, deferred: true });
    expect(tight.remainingD1Queries()).toBe(0);
    const second = await runRetentionStage(env, createCronBudget(), NOW);
    expect(second).toMatchObject({ eventsDeleted: 1, deferred: false });
  });

  it('works in bounded batches of 500', async () => {
    const ins = db.prepare(`INSERT INTO insight_events (id, learner_id, idempotency_key, session_ref, source_runtime, adapter_version, payload_json,
      payload_bytes, status, next_attempt_at, turn_ended_at, received_at) VALUES (?, 'lrn_a', ?, 's', 'claude-code', '0.1.0', '{}', 2, 'pending', ?, ?, ?)`);
    await db.batch(Array.from({ length: 520 }, (_, i) => ins.bind(`iev_${i}`, `k${i}`, ago(50), ago(50), ago(50))));
    expect((await runRetentionStage(env, createCronBudget(), NOW)).eventsStaled).toBe(500);
    expect((await runRetentionStage(env, createCronBudget(), NOW)).eventsStaled).toBe(20);
  });
});
