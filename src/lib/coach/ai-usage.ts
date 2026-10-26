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
 *
 * Grading is protected from coaching traffic: calls in the 'coaching' pool (practice chat and hints) are
 * also tracked in the coach_* columns of both rows, and the same conditional UPDATE refuses them once the
 * coaching spend on either row would pass `coachShare` of that row's caps (the learner's own caps and the
 * global caps). Grading ('grading' pool) may use the full caps, so coaching alone can never leave grading
 * without budget, neither globally nor for the learner's own submissions.
 */
import {
  DEFAULT_BUDGET_USD_GLOBAL, DEFAULT_BUDGET_USD_PER_LEARNER, DEFAULT_COACH_SHARE, DEFAULT_WORKERS_AI_DAILY_REQUESTS_GLOBAL,
  WORKERS_AI_DAILY_REQUESTS_PER_LEARNER,
} from './ai-models';

export const GLOBAL_USAGE_ID = '*';

/** Which slice of the global caps a call draws from. */
export type BudgetPool = 'grading' | 'coaching';

export interface UsageTotals {
  requests: number;
  costUsd: number;
  reservedUsd: number;
  workersAiRequests: number;
  /** The coaching part of the totals above (already included in them). */
  coachCostUsd: number;
  coachReservedUsd: number;
  coachWorkersAiRequests: number;
}

export interface BudgetLimits {
  perLearnerUsd: number;
  globalUsd: number;
  workersAiPerLearner: number;
  workersAiGlobal: number;
  /** A learner's USD that their own coaching (chat + hints) may use per day: perLearnerUsd × share. */
  coachPerLearnerUsd: number;
  /** A learner's Workers AI calls that their own coaching may use per day: floor(workersAiPerLearner × share). */
  coachWorkersAiPerLearner: number;
  /** Global USD that coaching (chat + hints) may use per day: globalUsd × share. */
  coachGlobalUsd: number;
  /** Global Workers AI calls that coaching may use per day: floor(workersAiGlobal × share). */
  coachWorkersAiGlobal: number;
}

const positive = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Share of the per-learner and global caps open to coaching, from AI_DAILY_COACH_SHARE; values outside [0, 1] use the default. */
export function coachShare(raw: string | undefined): number {
  const n = positive(raw, DEFAULT_COACH_SHARE);
  return n <= 1 ? n : DEFAULT_COACH_SHARE;
}

export function budgetLimits(
  env: Pick<Env, 'AI_DAILY_BUDGET_USD_PER_LEARNER' | 'AI_DAILY_BUDGET_USD_GLOBAL' | 'AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL' | 'AI_DAILY_COACH_SHARE'>,
): BudgetLimits {
  const globalUsd = positive(env.AI_DAILY_BUDGET_USD_GLOBAL, DEFAULT_BUDGET_USD_GLOBAL);
  const workersAiGlobal = Math.floor(positive(env.AI_DAILY_WORKERS_AI_REQUESTS_GLOBAL, DEFAULT_WORKERS_AI_DAILY_REQUESTS_GLOBAL));
  const perLearnerUsd = positive(env.AI_DAILY_BUDGET_USD_PER_LEARNER, DEFAULT_BUDGET_USD_PER_LEARNER);
  const share = coachShare(env.AI_DAILY_COACH_SHARE);
  return {
    perLearnerUsd,
    globalUsd,
    workersAiPerLearner: WORKERS_AI_DAILY_REQUESTS_PER_LEARNER,
    workersAiGlobal,
    coachPerLearnerUsd: perLearnerUsd * share,
    coachWorkersAiPerLearner: Math.floor(WORKERS_AI_DAILY_REQUESTS_PER_LEARNER * share),
    coachGlobalUsd: globalUsd * share,
    coachWorkersAiGlobal: Math.floor(workersAiGlobal * share),
  };
}

interface UsageRow {
  learner_id: string; requests: number; cost_usd: number; reserved_usd: number; workers_ai_requests: number;
  coach_cost_usd: number; coach_reserved_usd: number; coach_workers_ai_requests: number;
}

const empty = (): UsageTotals => ({
  requests: 0, costUsd: 0, reservedUsd: 0, workersAiRequests: 0, coachCostUsd: 0, coachReservedUsd: 0, coachWorkersAiRequests: 0,
});

export async function readUsage(db: D1Database, day: string, learnerId: string): Promise<{ learner: UsageTotals; global: UsageTotals }> {
  const { results } = await db.prepare(
    `SELECT learner_id, requests, cost_usd, reserved_usd, workers_ai_requests, coach_cost_usd, coach_reserved_usd, coach_workers_ai_requests
     FROM ai_usage WHERE day = ? AND learner_id IN (?, ?)`,
  ).bind(day, learnerId, GLOBAL_USAGE_ID).all<UsageRow>();
  const out = { learner: empty(), global: empty() };
  for (const r of results) {
    const t: UsageTotals = {
      requests: r.requests, costUsd: r.cost_usd, reservedUsd: r.reserved_usd, workersAiRequests: r.workers_ai_requests,
      coachCostUsd: r.coach_cost_usd, coachReservedUsd: r.coach_reserved_usd, coachWorkersAiRequests: r.coach_workers_ai_requests,
    };
    if (r.learner_id === GLOBAL_USAGE_ID) out.global = t;
    else out.learner = t;
  }
  return out;
}

/** 1 for coaching, 0 for grading: scales the coach_* deltas and switches the share check on or off in SQL. */
const coachFlag = (pool: BudgetPool): number => (pool === 'coaching' ? 1 : 0);

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
 * Reserves `amountUsd` against both the learner's and the global daily USD caps (and, for coaching, the
 * coaching share of each). The cap check is an uncorrelated subquery, evaluated once for the statement, so
 * both rows move together or not at all.
 */
export async function reserveUsd(
  db: D1Database, day: string, learnerId: string, amountUsd: number, limits: BudgetLimits, pool: BudgetPool,
): Promise<boolean> {
  const update = db.prepare(
    `UPDATE ai_usage SET reserved_usd = reserved_usd + ?1, coach_reserved_usd = coach_reserved_usd + ?1 * ?8
     WHERE day = ?2 AND learner_id IN (?3, ?4)
       AND (SELECT COUNT(*) FROM ai_usage WHERE day = ?2 AND (
         (learner_id = ?3 AND cost_usd + reserved_usd + ?1 <= ?5
             AND (?8 = 0 OR coach_cost_usd + coach_reserved_usd + ?1 <= ?9))
         OR (learner_id = ?4 AND cost_usd + reserved_usd + ?1 <= ?6
             AND (?8 = 0 OR coach_cost_usd + coach_reserved_usd + ?1 <= ?7))
       )) = 2`,
  ).bind(
    amountUsd, day, learnerId, GLOBAL_USAGE_ID, limits.perLearnerUsd, limits.globalUsd, limits.coachGlobalUsd, coachFlag(pool),
    limits.coachPerLearnerUsd,
  );
  return conditionalUpdateBothRows(db, day, learnerId, update);
}

/**
 * Counts one Workers AI call against the per-learner and global daily caps (and, for coaching, the
 * coaching share of each); false when any of them is spent.
 */
export async function reserveWorkersAiCall(
  db: D1Database, day: string, learnerId: string, limits: BudgetLimits, pool: BudgetPool,
): Promise<boolean> {
  const update = db.prepare(
    `UPDATE ai_usage SET workers_ai_requests = workers_ai_requests + 1, coach_workers_ai_requests = coach_workers_ai_requests + ?7
     WHERE day = ?1 AND learner_id IN (?2, ?3)
       AND (SELECT COUNT(*) FROM ai_usage WHERE day = ?1 AND (
         (learner_id = ?2 AND workers_ai_requests < ?4 AND (?7 = 0 OR coach_workers_ai_requests < ?8))
         OR (learner_id = ?3 AND workers_ai_requests < ?5 AND (?7 = 0 OR coach_workers_ai_requests < ?6))
       )) = 2`,
  ).bind(
    day, learnerId, GLOBAL_USAGE_ID, limits.workersAiPerLearner, limits.workersAiGlobal, limits.coachWorkersAiGlobal, coachFlag(pool),
    limits.coachWorkersAiPerLearner,
  );
  return conditionalUpdateBothRows(db, day, learnerId, update);
}

/** Drops a reservation whose call never completed. */
export async function releaseUsd(db: D1Database, day: string, learnerId: string, amountUsd: number, pool: BudgetPool): Promise<void> {
  await db.prepare(
    `UPDATE ai_usage SET reserved_usd = MAX(0, reserved_usd - ?1), coach_reserved_usd = MAX(0, coach_reserved_usd - ?1 * ?2)
     WHERE day = ?3 AND learner_id IN (?4, ?5)`,
  ).bind(amountUsd, coachFlag(pool), day, learnerId, GLOBAL_USAGE_ID).run();
}

/**
 * Records a completed call on both rows: one request, its tokens and estimated cost, minus the USD it had
 * reserved. Workers AI calls were already counted by `reserveWorkersAiCall`.
 */
export async function settleUsage(
  db: D1Database, day: string, learnerId: string, pool: BudgetPool,
  delta: { inputTokens: number; outputTokens: number; costUsd: number; reservedUsd: number },
): Promise<void> {
  const upsert = (id: string) => db.prepare(
    `INSERT INTO ai_usage (day, learner_id, requests, input_tokens, output_tokens, cost_usd, coach_cost_usd)
     VALUES (?1, ?2, 1, ?3, ?4, ?5, ?5 * ?7)
     ON CONFLICT (day, learner_id) DO UPDATE SET
       requests = requests + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_usd = cost_usd + excluded.cost_usd,
       coach_cost_usd = coach_cost_usd + excluded.coach_cost_usd,
       reserved_usd = MAX(0, reserved_usd - ?6),
       coach_reserved_usd = MAX(0, coach_reserved_usd - ?6 * ?7)`,
  ).bind(day, id, delta.inputTokens, delta.outputTokens, delta.costUsd, delta.reservedUsd, coachFlag(pool));
  await db.batch([upsert(learnerId), upsert(GLOBAL_USAGE_ID)]);
}
