/**
 * Insights cron stage (stub): links product observations to de-identified signals, creates proposals and,
 * only when the policy gate and GitHub mode allow it, files GitHub issues.
 *
 * The proposal-pipeline work replaces this body and keeps the signature (`InsightsStage` in
 * insight-types.ts). It must charge every D1 query and fetch to `budget`, stop when `budget.canAfford` says
 * no, and resume from durable state on the next tick.
 */
import type { CronBudget } from '../jobs/cron-budget';

export async function runProposalStage(_env: Env, _budget: CronBudget, _now: Date): Promise<{ stub: true }> {
  return { stub: true };
}
