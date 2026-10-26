/**
 * Insights retention, the first stage of the `insights-pipeline` cron job (pipeline-job.ts). Each step is
 * one bounded statement (LIMIT 500) charged to the shared cron budget as one D1 query; when the budget
 * cannot afford the next step the stage stops and the next tick resumes from the table state.
 *
 * 1. Reports past `expires_at` are deleted (their signal evidence cascades).
 * 2. Events still `pending` QUEUE_STALE_AFTER_HOURS after they were received become `skipped`/`stale`
 *    (same update as the analyzer queue's stale sweep; running both is idempotent).
 * 3. Any `done`/`skipped`/`dead` event still holding a payload has it NULLed (dead-letter rows included).
 * 4. `done`/`skipped`/`dead` events older than QUEUE_RETENTION_DAYS are deleted.
 * 5. Signals with no evidence left and no proposal are deleted.
 */
import type { CronBudget } from '../jobs/cron-budget';
import { nowIso } from '../db/ids';
import { QUEUE_RETENTION_DAYS, QUEUE_STALE_AFTER_HOURS } from './feature-flags';

export const RETENTION_BATCH_LIMIT = 500;
const HOUR_MS = 60 * 60_000;
const STEP_COST = { d1: 1 } as const;

export interface RetentionResult {
  reportsDeleted: number;
  eventsStaled: number;
  payloadsNulled: number;
  eventsDeleted: number;
  signalsDeleted: number;
  /** True when the budget ran out before every step ran. */
  deferred: boolean;
}

export async function runRetentionStage(env: Env, budget: CronBudget, now: Date): Promise<RetentionResult> {
  const db = env.DB;
  const ts = nowIso(now);
  const staleBefore = nowIso(new Date(now.getTime() - QUEUE_STALE_AFTER_HOURS * HOUR_MS));
  const keepAfter = nowIso(new Date(now.getTime() - QUEUE_RETENTION_DAYS * 24 * HOUR_MS));
  const limit = RETENTION_BATCH_LIMIT;

  const steps: Array<[keyof Omit<RetentionResult, 'deferred'>, D1PreparedStatement]> = [
    ['reportsDeleted', db.prepare(
      `DELETE FROM insight_reports WHERE id IN (SELECT id FROM insight_reports WHERE expires_at < ? LIMIT ?)`,
    ).bind(ts, limit)],
    ['eventsStaled', db.prepare(
      `UPDATE insight_events SET status = 'skipped', skip_reason = 'stale', payload_json = NULL, lease_id = NULL,
              lease_until = NULL, processed_at = ?1
        WHERE id IN (SELECT id FROM insight_events WHERE status = 'pending' AND received_at < ?2 LIMIT ?3)`,
    ).bind(ts, staleBefore, limit)],
    ['payloadsNulled', db.prepare(
      `UPDATE insight_events SET payload_json = NULL
        WHERE id IN (SELECT id FROM insight_events WHERE status IN ('done', 'skipped', 'dead') AND payload_json IS NOT NULL LIMIT ?)`,
    ).bind(limit)],
    ['eventsDeleted', db.prepare(
      `DELETE FROM insight_events WHERE id IN (
         SELECT id FROM insight_events
          WHERE status IN ('done', 'skipped', 'dead') AND COALESCE(processed_at, received_at) < ? LIMIT ?)`,
    ).bind(keepAfter, limit)],
    ['signalsDeleted', db.prepare(
      `DELETE FROM insight_signals WHERE id IN (
         SELECT s.id FROM insight_signals s
          WHERE NOT EXISTS (SELECT 1 FROM insight_signal_evidence e WHERE e.signal_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM insight_proposals p WHERE p.signal_id = s.id)
          LIMIT ?)`,
    ).bind(limit)],
  ];

  const result: RetentionResult = {
    reportsDeleted: 0, eventsStaled: 0, payloadsNulled: 0, eventsDeleted: 0, signalsDeleted: 0, deferred: false,
  };
  for (const [name, stmt] of steps) {
    if (!budget.canAfford(STEP_COST)) {
      result.deferred = true;
      break;
    }
    budget.charge(STEP_COST);
    result[name] = (await stmt.run()).meta.changes ?? 0;
  }
  return result;
}
