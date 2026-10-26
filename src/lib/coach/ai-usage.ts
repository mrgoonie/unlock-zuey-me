/**
 * AI spend tracking (ai_usage): one row per learner per UTC day plus a global row (learner_id '*').
 * Costs are estimates from returned token usage × the price table in ai-models.ts.
 *
 * Budgets are enforced with reserve-then-settle so concurrent calls cannot all pass a read-then-check:
 * - OpenRouter: `reserveUsd` adds the call's worst-case cost to `reserved_usd` on both rows in ONE
 *   conditional UPDATE that succeeds only while both rows stay within their caps; `settleUsage` then swaps
 *   the reservation for the real cost (or `releaseUsd` drops it when the call fails).
 * - Workers AI: `reserveWorkersAiCall` counts the call up front on both rows with the same conditional
 *   pattern, against the per-learner and the global daily request caps.
 * A Worker that dies mid-call leaves its reservation until the day rolls over, erring on the safe side.
 */
import {
  DEFAULT_BUDGET_USD_GLOBAL, DEFAULT_BUDGET_USD_PER_LEARNER, DEFAULT_WORKERS_AI_DAILY_REQUESTS_GLOBAL,
  WORKERS_AI_DAILY_REQUESTS_PER_LEARNER,
} from './ai-models';

export const GLOBAL_USAGE_ID = '*';

export interface UsageTotals {
  requests: number;
  costUsd: number;
  reservedUsd: number;
  workersAiRequests: number;
}

export interface BudgetLimits {
  perLearnerUsd: number;
  globalUsd: number;
  workersAiPerLearner: number;
  workersAiGlobal: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function budgetLimits(
  env: Pick<Env, 'AI_DAILY_BUDGET_USD_PER_LEARNER' | 'AI_DAILY_BUDGET_USD_GLOBAL' | 'AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL'>,
): BudgetLimits {
  return {
    perLearnerUsd: positive(env.AI_DAILY_BUDGET_USD_PER_LEARNER, DEFAULT_BUDGET_USD_PER_LEARNER),
    globalUsd: positive(env.AI_DAILY_BUDGET_USD_GLOBAL, DEFAULT_BUDGET_USD_GLOBAL),
    workersAiPerLearner: WORKERS_AI_DAILY_REQUESTS_PER_LEARNER,
    workersAiGlobal: Math.floor(positive(env.AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL, DEFAULT_WORKERS_AI_DAILY_REQUESTS_GLOBAL)),
  };
}

interface UsageRow { learner_id: string; requests: number; cost_usd: number; reserved_usd: number; workers_ai_requests: number }

const empty = (): UsageTotals => ({ requests: 0, costUsd: 0, reservedUsd: 0, workersAiRequests: 0 });

export async function readUsage(db: D1Database, day: string, learnerId: string): Promise<{ learner: UsageTotals; global: UsageTotals }> {
  const { results } = await db.prepare(
    'SELECT learner_id, requests, cost_usd, reserved_usd, workers_ai_requests FROM ai_usage WHERE day = ? AND learner_id IN (?, ?)',
  ).bind(day, learnerId, GLOBAL_USAGE_ID).all<UsageRow>();
  const out = { learner: empty(), global: empty() };
  for (const r of results) {
    const t = { requests: r.requests, costUsd: r.cost_usd, reservedUsd: r.reserved_usd, workersAiRequests: r.workers_ai_requests };
    if (r.learner_id === GLOBAL_USAGE_ID) out.global = t;
    else out.learner = t;
  }
  return out;
}

const ensureRow = (db: D1Database, day: string, id: string) =>
  db.prepare('INSERT OR IGNORE INTO ai_usage (day, learner_id, requests) VALUES (?, ?, 0)').bind(day, id);

/**
 * Runs `update` (which must touch both rows or neither) after making sure both rows exist, in one atomic
 * batch. Returns true when both rows were updated.
 */
async function conditionalUpdateBothRows(db: D1Database, day: string, learnerId: string, update: D1PreparedStatement): Promise<boolean> {
  const results = await db.batch([ensureRow(db, day, learnerId), ensureRow(db, day, GLOBAL_USAGE_ID), update]);
  const changes = Number(results[2]?.meta?.changes ?? 0);
  if (changes !== 0 && changes !== 2) console.error('ai usage reservation touched one row only', { day, changes });
  return changes > 0;
}

/**
 * Reserves `amountUsd` against both the learner's and the global daily USD caps. The cap check is an
 * uncorrelated subquery, evaluated once for the statement, so both rows move together or not at all.
 */
export async function reserveUsd(db: D1Database, day: string, learnerId: string, amountUsd: number, limits: BudgetLimits): Promise<boolean> {
  const update = db.prepare(
    `UPDATE ai_usage SET reserved_usd = reserved_usd + ?1
     WHERE day = ?2 AND learner_id IN (?3, ?4)
       AND (SELECT COUNT(*) FROM ai_usage WHERE day = ?2 AND (
         (learner_id = ?3 AND cost_usd + reserved_usd + ?1 <= ?5) OR (learner_id = ?4 AND cost_usd + reserved_usd + ?1 <= ?6)
       )) = 2`,
  ).bind(amountUsd, day, learnerId, GLOBAL_USAGE_ID, limits.perLearnerUsd, limits.globalUsd);
  return conditionalUpdateBothRows(db, day, learnerId, update);
}

/** Counts one Workers AI call against the per-learner and global daily caps; false when either is spent. */
export async function reserveWorkersAiCall(db: D1Database, day: string, learnerId: string, limits: BudgetLimits): Promise<boolean> {
  const update = db.prepare(
    `UPDATE ai_usage SET workers_ai_requests = workers_ai_requests + 1
     WHERE day = ?1 AND learner_id IN (?2, ?3)
       AND (SELECT COUNT(*) FROM ai_usage WHERE day = ?1 AND (
         (learner_id = ?2 AND workers_ai_requests < ?4) OR (learner_id = ?3 AND workers_ai_requests < ?5)
       )) = 2`,
  ).bind(day, learnerId, GLOBAL_USAGE_ID, limits.workersAiPerLearner, limits.workersAiGlobal);
  return conditionalUpdateBothRows(db, day, learnerId, update);
}

/** Drops a reservation whose call never completed. */
export async function releaseUsd(db: D1Database, day: string, learnerId: string, amountUsd: number): Promise<void> {
  await db.prepare('UPDATE ai_usage SET reserved_usd = MAX(0, reserved_usd - ?) WHERE day = ? AND learner_id IN (?, ?)')
    .bind(amountUsd, day, learnerId, GLOBAL_USAGE_ID).run();
}

/**
 * Records a completed call on both rows: one request, its tokens and estimated cost, minus the USD it had
 * reserved. Workers AI calls were already counted by `reserveWorkersAiCall`.
 */
export async function settleUsage(
  db: D1Database, day: string, learnerId: string,
  delta: { inputTokens: number; outputTokens: number; costUsd: number; reservedUsd: number },
): Promise<void> {
  const upsert = (id: string) => db.prepare(
    `INSERT INTO ai_usage (day, learner_id, requests, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT (day, learner_id) DO UPDATE SET
       requests = requests + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_usd = cost_usd + excluded.cost_usd,
       reserved_usd = MAX(0, reserved_usd - ?)`,
  ).bind(day, id, delta.inputTokens, delta.outputTokens, delta.costUsd, delta.reservedUsd);
  await db.batch([upsert(learnerId), upsert(GLOBAL_USAGE_ID)]);
}
