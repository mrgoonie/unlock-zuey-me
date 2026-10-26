/**
 * The `insights-pipeline` cron job (last in scheduled-jobs.ts). With INSIGHTS_MODE off it returns at once
 * without touching D1, KV or the network and charges nothing. Otherwise it runs the stages in order
 * against the shared cron budget: retention first (so revoked or expired data is gone before anything reads
 * it), then the ai-tutor analyzer, then the proposal pipeline. A failing stage is logged and the next one
 * still runs; a stage is deferred to the next tick once the budget is spent.
 */
import type { CronBudget } from '../jobs/cron-budget';
import { runAnalyzerStage } from './analyzer-stage';
import { insightsMode } from './feature-flags';
import type { InsightsPipelineResult, InsightsStage, InsightsStageOutcome } from './insight-types';
import { runProposalStage } from './proposal-stage';
import { runRetentionStage } from './retention-stage';

export interface InsightsPipelineStages {
  retention: InsightsStage;
  analyzer: InsightsStage;
  proposal: InsightsStage;
}

const DEFAULT_STAGES: InsightsPipelineStages = {
  retention: runRetentionStage,
  analyzer: runAnalyzerStage,
  proposal: runProposalStage,
};

async function runStage(name: string, stage: InsightsStage, env: Env, budget: CronBudget, now: Date): Promise<InsightsStageOutcome> {
  if (budget.exhausted()) return { status: 'deferred' };
  try {
    return { status: 'ok', result: await stage(env, budget, now) };
  } catch (err) {
    console.error(`insights-pipeline stage ${name} failed`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runInsightsPipeline(
  env: Env,
  budget: CronBudget,
  now: Date = new Date(),
  stages: InsightsPipelineStages = DEFAULT_STAGES,
): Promise<InsightsPipelineResult> {
  const mode = insightsMode(env);
  if (mode === 'off') return { skipped: 'flag_off' };
  const retention = await runStage('retention', stages.retention, env, budget, now);
  const analyzer = await runStage('analyzer', stages.analyzer, env, budget, now);
  const proposal = await runStage('proposal', stages.proposal, env, budget, now);
  return { mode, retention, analyzer, proposal };
}
