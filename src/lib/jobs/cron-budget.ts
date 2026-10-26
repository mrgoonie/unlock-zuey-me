/**
 * Shared wall-clock and subrequest budget for one cron invocation. Every D1 query/batch, KV, R2 and push
 * call counts toward the Worker's per-invocation subrequest limit, and all cron jobs share one invocation,
 * so the dispatcher runs them one after another against a single budget. Each job charges what it uses
 * (exactly where it can, a conservative estimate otherwise), stops early once the budget is spent and
 * resumes on the next tick from its own saved position.
 */

/** Wall-clock budget for all jobs of one tick; well under the 15-minute cron interval so ticks never overlap. */
export const CRON_TIME_BUDGET_MS = 8 * 60_000;
/** Subrequests all jobs of one tick may use, with headroom under the Workers 10k per-invocation limit. */
export const CRON_SUBREQUEST_BUDGET = 9_000;

export interface CronBudget {
  /** Records `n` subrequests as used. */
  charge(n: number): void;
  /** True once either the time or the subrequest budget is spent. */
  exhausted(): boolean;
  remainingMs(): number;
  remainingSubrequests(): number;
}

export function createCronBudget(opts: { timeMs?: number; subrequests?: number; clock?: () => number } = {}): CronBudget {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.timeMs ?? CRON_TIME_BUDGET_MS);
  let left = opts.subrequests ?? CRON_SUBREQUEST_BUDGET;
  return {
    charge(n) {
      left -= Math.max(0, n);
    },
    exhausted: () => left <= 0 || clock() >= deadline,
    remainingMs: () => Math.max(0, deadline - clock()),
    remainingSubrequests: () => Math.max(0, left),
  };
}
