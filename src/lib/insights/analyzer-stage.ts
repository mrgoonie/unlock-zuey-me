/**
 * Insights cron stage (stub): claims ready session windows from insight_events and turns each into one
 * ai-tutor report through runAi.
 *
 * The analyzer/queue work replaces this body and keeps the signature (`InsightsStage` in insight-types.ts).
 * It must charge every D1 query and AI call to `budget`, stop when `budget.canAfford` says no, and resume
 * from durable state on the next tick.
 */
import type { CronBudget } from '../jobs/cron-budget';

export async function runAnalyzerStage(_env: Env, _budget: CronBudget, _now: Date): Promise<{ stub: true }> {
  return { stub: true };
}
