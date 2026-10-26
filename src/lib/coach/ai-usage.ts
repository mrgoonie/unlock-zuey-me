/**
 * AI spend tracking (ai_usage): one row per learner per UTC day plus a global row (learner_id '*').
 * Costs are estimates from returned token usage × the price table in ai-models.ts.
 */
import {
  DEFAULT_BUDGET_USD_GLOBAL, DEFAULT_BUDGET_USD_PER_LEARNER, WORKERS_AI_DAILY_REQUESTS_PER_LEARNER,
} from './ai-models';

export const GLOBAL_USAGE_ID = '*';

export interface UsageTotals {
  requests: number;
  costUsd: number;
  workersAiRequests: number;
}

export interface BudgetLimits {
  perLearnerUsd: number;
  globalUsd: number;
  workersAiPerLearner: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function budgetLimits(env: Pick<Env, 'AI_DAILY_BUDGET_USD_PER_LEARNER' | 'AI_DAILY_BUDGET_USD_GLOBAL'>): BudgetLimits {
  return {
    perLearnerUsd: positive(env.AI_DAILY_BUDGET_USD_PER_LEARNER, DEFAULT_BUDGET_USD_PER_LEARNER),
    globalUsd: positive(env.AI_DAILY_BUDGET_USD_GLOBAL, DEFAULT_BUDGET_USD_GLOBAL),
    workersAiPerLearner: WORKERS_AI_DAILY_REQUESTS_PER_LEARNER,
  };
}

interface UsageRow { learner_id: string; requests: number; cost_usd: number; workers_ai_requests: number }

const empty = (): UsageTotals => ({ requests: 0, costUsd: 0, workersAiRequests: 0 });

export async function readUsage(db: D1Database, day: string, learnerId: string): Promise<{ learner: UsageTotals; global: UsageTotals }> {
  const { results } = await db.prepare(
    'SELECT learner_id, requests, cost_usd, workers_ai_requests FROM ai_usage WHERE day = ? AND learner_id IN (?, ?)',
  ).bind(day, learnerId, GLOBAL_USAGE_ID).all<UsageRow>();
  const out = { learner: empty(), global: empty() };
  for (const r of results) {
    const t = { requests: r.requests, costUsd: r.cost_usd, workersAiRequests: r.workers_ai_requests };
    if (r.learner_id === GLOBAL_USAGE_ID) out.global = t;
    else out.learner = t;
  }
  return out;
}

export async function recordUsage(
  db: D1Database, day: string, learnerId: string,
  delta: { inputTokens: number; outputTokens: number; costUsd: number; workersAi: boolean },
): Promise<void> {
  const upsert = (id: string) => db.prepare(
    `INSERT INTO ai_usage (day, learner_id, requests, input_tokens, output_tokens, cost_usd, workers_ai_requests)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT (day, learner_id) DO UPDATE SET
       requests = requests + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_usd = cost_usd + excluded.cost_usd,
       workers_ai_requests = workers_ai_requests + excluded.workers_ai_requests`,
  ).bind(day, id, delta.inputTokens, delta.outputTokens, delta.costUsd, delta.workersAi ? 1 : 0);
  await db.batch([upsert(learnerId), upsert(GLOBAL_USAGE_ID)]);
}
