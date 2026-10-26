/**
 * Cron dispatcher (wrangler.jsonc triggers: every 15 minutes, UTC).
 *
 * All jobs share one Worker invocation and therefore one subrequest limit, so they run one after another
 * (push reminders first: they are time-sensitive) against a shared time/subrequest budget (cron-budget.ts).
 * Each job sizes its work to what is left and stops early when the budget is spent; every job keeps its own
 * resume position (look-back window, KV cursor, saved key), so the next tick carries on. A failing job is
 * logged and the next job still runs.
 */
import { OAUTH_PURGE_BATCH_SIZE, purgeExpiredAuthData } from '../mcp/oauth-purge';
import { MAX_SENDS_PER_RUN, sendDueReminders, TIME_BUDGET_MS as PUSH_TIME_BUDGET_MS } from '../push/reminder-job';
import { createCronBudget, type CronBudget } from './cron-budget';
import { GUEST_CLEANUP_BATCH, removeInactiveGuests } from './inactive-guest-cleanup';
import { deleteOrphanEvidence, EVIDENCE_GC_PAGES_PER_RUN } from './orphan-evidence-cleanup';

export interface CronJob {
  name: string;
  run: (budget: CronBudget) => Promise<unknown>;
}

/** Estimated subrequests per push: claim, open-run lookup, push service, result update, event. */
const PUSH_SUBREQUESTS_PER_SEND = 5;
/** Push job queries that do not scale with sends (timezone list, batch selects). */
const PUSH_OVERHEAD_SUBREQUESTS = 20;
/** Worst case per OAuth item checked (read, client read, revoke), for both the grant and the token phase. */
const OAUTH_SUBREQUESTS_PER_ITEM = 10;
/** CACHE cursor read/write and the two D1 purges. */
const OAUTH_OVERHEAD_SUBREQUESTS = 6;

/** The cron jobs, in run order. */
export function scheduledJobs(env: Env): CronJob[] {
  return [
    {
      name: 'push-reminders',
      run: async (budget) => {
        const maxSends = Math.min(
          MAX_SENDS_PER_RUN, Math.floor((budget.remainingSubrequests() - PUSH_OVERHEAD_SUBREQUESTS) / PUSH_SUBREQUESTS_PER_SEND),
        );
        if (maxSends <= 0) return { deferred: true };
        let handled = maxSends;
        try {
          const r = await sendDueReminders(env, { maxSends, timeBudgetMs: Math.min(PUSH_TIME_BUDGET_MS, budget.remainingMs()) });
          handled = r.sent + r.removed + r.failed + r.skipped;
          return r;
        } finally {
          // On failure the work done is unknown, so the worst case is charged.
          budget.charge(PUSH_OVERHEAD_SUBREQUESTS + handled * PUSH_SUBREQUESTS_PER_SEND);
        }
      },
    },
    {
      name: 'oauth-purge',
      run: async (budget) => {
        const batch = Math.min(
          OAUTH_PURGE_BATCH_SIZE, Math.floor((budget.remainingSubrequests() - OAUTH_OVERHEAD_SUBREQUESTS) / OAUTH_SUBREQUESTS_PER_ITEM),
        );
        if (batch <= 0) return { deferred: true };
        budget.charge(OAUTH_OVERHEAD_SUBREQUESTS + batch * OAUTH_SUBREQUESTS_PER_ITEM);
        return purgeExpiredAuthData(env, new Date(), batch);
      },
    },
    // Abuse/cost hygiene: abandoned guests and evidence images that were never submitted.
    { name: 'guest-cleanup', run: (budget) => removeInactiveGuests(env, new Date(), GUEST_CLEANUP_BATCH, budget) },
    { name: 'evidence-gc', run: (budget) => deleteOrphanEvidence(env, new Date(), EVIDENCE_GC_PAGES_PER_RUN, budget) },
  ];
}

/** Runs `jobs` sequentially against `budget`; a failing job is logged and does not stop the next one. */
export async function runCronJobs(cron: string, jobs: CronJob[], budget: CronBudget): Promise<void> {
  for (const job of jobs) {
    if (budget.exhausted()) {
      console.warn(`cron ${cron} job ${job.name} deferred to the next tick: run budget spent`);
      continue;
    }
    try {
      await job.run(budget);
    } catch (err) {
      console.error(`cron ${cron} job ${job.name} failed`, err);
    }
  }
}

export async function runScheduledJobs(cron: string, env: Env): Promise<void> {
  await runCronJobs(cron, scheduledJobs(env), createCronBudget());
}
