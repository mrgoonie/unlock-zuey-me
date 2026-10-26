/**
 * Cron dispatcher (wrangler.jsonc triggers: every 15 minutes, UTC).
 *
 * All jobs share one Worker invocation and therefore one subrequest limit, so they run one after another
 * (push reminders first: they are time-sensitive) against a shared time/subrequest budget (cron-budget.ts).
 * Each job sizes its work to what is left and stops early when the budget is spent; every job keeps its own
 * resume position (look-back window, KV cursor, saved key), so the next tick carries on. A failing job is
 * logged and the next job still runs.
 */
import type { PurgeResult } from '@cloudflare/workers-oauth-provider';
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
/**
 * Worst case per unit of OAuth batch (record read, owner read, revoke), for both the grant and the token
 * phase. Used only to size the batch so even the worst case fits what is left of the budget.
 */
const OAUTH_SUBREQUESTS_PER_ITEM = 10;
/** CACHE cursor read/write and the two D1 purges. */
const OAUTH_OVERHEAD_SUBREQUESTS = 6;
/** Estimate per OAuth record checked: its KV read plus the read of its client (grant) or grant (token). */
const OAUTH_SUBREQUESTS_PER_CHECKED = 2;
/** Extra estimate per record purged: revocation lists and deletes the grant's tokens and the record. */
const OAUTH_SUBREQUESTS_PER_PURGED = 4;
/** KV list page size used by the OAuth sweep. */
const OAUTH_LIST_PAGE = 1000;

/**
 * Subrequests charged for one OAuth purge batch: proportional to what it actually checked and purged (KV
 * list pages included), capped at the worst case reserved for `batch`, so an idle sweep does not starve the
 * jobs after it.
 */
export function oauthPurgeSubrequests(result: PurgeResult, batch: number): number {
  const listPages = Math.ceil(result.grantsChecked / OAUTH_LIST_PAGE) + Math.ceil(result.tokensChecked / OAUTH_LIST_PAGE) + 2;
  const estimate = OAUTH_OVERHEAD_SUBREQUESTS + listPages
    + (result.grantsChecked + result.tokensChecked) * OAUTH_SUBREQUESTS_PER_CHECKED
    + (result.grantsPurged + result.tokensPurged) * OAUTH_SUBREQUESTS_PER_PURGED;
  return Math.min(estimate, OAUTH_OVERHEAD_SUBREQUESTS + batch * OAUTH_SUBREQUESTS_PER_ITEM);
}

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
        let result: PurgeResult | undefined;
        try {
          result = await purgeExpiredAuthData(env, new Date(), batch);
          return result;
        } finally {
          // On failure the work done is unknown, so the worst case reserved for this batch is charged.
          budget.charge(result ? oauthPurgeSubrequests(result, batch) : OAUTH_OVERHEAD_SUBREQUESTS + batch * OAUTH_SUBREQUESTS_PER_ITEM);
        }
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
