/**
 * Shared wall-clock and request budget for one cron invocation. All cron jobs share one Worker invocation,
 * so the dispatcher runs them one after another against a single budget. Each job charges what it uses
 * (exactly where it can, a conservative estimate otherwise), checks `canAfford` before each step, stops
 * early once the budget is spent and resumes on the next tick from its own saved position.
 *
 * Cloudflare enforces two separate per-invocation limits, so the budget tracks both:
 * - D1 queries: 1,000 per invocation on Workers Paid; a `db.batch()` counts as ONE query
 *   (https://developers.cloudflare.com/d1/platform/limits/, "Queries per Worker invocation").
 * - Subrequests: 10,000 per invocation on Workers Paid. A subrequest is any fetch() plus any call to
 *   Cloudflare services such as KV, R2 and D1, so D1 queries count toward this limit too
 *   (https://developers.cloudflare.com/workers/platform/limits/, "Subrequests").
 * Hence a cost is split into `d1` (D1 queries/batches) and `net` (fetch to push services, KV, R2), and
 * `d1 + net` is charged against the subrequest budget. Both budgets keep 10% headroom under the hard limit
 * for estimates that undercount and for rare error paths.
 */

/** Wall-clock budget for all jobs of one tick; well under the 15-minute cron interval so ticks never overlap. */
export const CRON_TIME_BUDGET_MS = 8 * 60_000;
/** D1 queries (a batch counts once) all jobs of one tick may run; the hard limit is 1,000. */
export const CRON_D1_QUERY_BUDGET = 900;
/** Subrequests (D1 + fetch + KV + R2) all jobs of one tick may make; the hard limit is 10,000. */
export const CRON_SUBREQUEST_BUDGET = 9_000;

/** What one step costs. `d1` = D1 queries or batches; `net` = fetch, KV and R2 calls. */
export interface CronCost {
  d1?: number;
  net?: number;
}

/** A slice of the budget held back from a job (see `reserving`). */
export interface CronReserve {
  d1Queries: number;
  subrequests: number;
  timeMs: number;
}

export interface CronBudget {
  /** Records a step as used. */
  charge(cost: CronCost): void;
  /** True when the step fits in every remaining budget (time, D1 queries, subrequests). */
  canAfford(cost: CronCost): boolean;
  /** True once the time, D1 query or subrequest budget is spent. */
  exhausted(): boolean;
  remainingMs(): number;
  remainingD1Queries(): number;
  /** Remaining subrequests of any kind (D1 queries included). */
  remainingSubrequests(): number;
  /**
   * A view of this budget that hides `reserve`: it reports (and affords) only what is left above the
   * reserve, while charges still land on the shared budget. Used to keep a slice for later jobs.
   */
  reserving(reserve: CronReserve): CronBudget;
}

interface Remaining {
  ms: number;
  d1: number;
  subrequests: number;
}

const d1Of = (c: CronCost) => Math.max(0, c.d1 ?? 0);
const netOf = (c: CronCost) => Math.max(0, c.net ?? 0);

function makeBudget(remaining: () => Remaining, charge: (cost: CronCost) => void): CronBudget {
  return {
    charge,
    canAfford(cost) {
      const r = remaining();
      const d1 = d1Of(cost);
      return r.ms > 0 && r.d1 >= d1 && r.subrequests >= d1 + netOf(cost);
    },
    exhausted() {
      const r = remaining();
      return r.ms <= 0 || r.d1 <= 0 || r.subrequests <= 0;
    },
    remainingMs: () => remaining().ms,
    remainingD1Queries: () => remaining().d1,
    remainingSubrequests: () => remaining().subrequests,
    reserving(reserve) {
      return makeBudget(() => {
        const r = remaining();
        return {
          ms: Math.max(0, r.ms - reserve.timeMs),
          d1: Math.max(0, r.d1 - reserve.d1Queries),
          subrequests: Math.max(0, r.subrequests - reserve.subrequests),
        };
      }, charge);
    },
  };
}

export function createCronBudget(
  opts: { timeMs?: number; d1Queries?: number; subrequests?: number; clock?: () => number } = {},
): CronBudget {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.timeMs ?? CRON_TIME_BUDGET_MS);
  let d1Left = opts.d1Queries ?? CRON_D1_QUERY_BUDGET;
  let subLeft = opts.subrequests ?? CRON_SUBREQUEST_BUDGET;
  return makeBudget(
    () => ({ ms: Math.max(0, deadline - clock()), d1: Math.max(0, d1Left), subrequests: Math.max(0, subLeft) }),
    (cost) => {
      const d1 = d1Of(cost);
      d1Left -= d1;
      subLeft -= d1 + netOf(cost);
    },
  );
}
