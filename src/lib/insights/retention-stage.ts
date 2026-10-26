/**
 * Insights cron stage (stub): deletes expired reports and old queue rows, NULLs dead payloads, marks stale
 * pending events and prunes signals with no evidence left.
 *
 * The ingest/consent/privacy work replaces this body and keeps the signature (`InsightsStage` in
 * insight-types.ts). It must charge every D1 query to `budget`, stop when `budget.canAfford` says no, and
 * resume from durable state on the next tick.
 */
import type { CronBudget } from '../jobs/cron-budget';

export async function runRetentionStage(_env: Env, _budget: CronBudget, _now: Date): Promise<{ stub: true }> {
  return { stub: true };
}
