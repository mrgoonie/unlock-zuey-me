/**
 * Cron dispatcher (wrangler.jsonc triggers: every 15 minutes, UTC).
 *
 * All jobs share one Worker invocation and therefore one D1 query limit and one subrequest limit, so they
 * run one after another (push reminders first: they are time-sensitive) against a shared budget
 * (cron-budget.ts). Push reminders only see the budget above CLEANUP_RESERVE, so the cleanup jobs always get
 * a slice of every tick even when a busy quarter hour has more reminders than one tick can send. The
 * insights pipeline runs last and only sees what the cleanup jobs left. Each job
 * sizes its work to what is left and stops early when the budget is spent; every job keeps its own resume
 * position (look-back window, KV cursor, saved key), so the next tick carries on. A failing job is logged
 * and the next job still runs.
 */
import type { PurgeResult } from '@cloudflare/workers-oauth-provider';
import { runInsightsPipeline } from '../insights/pipeline-job';
import { OAUTH_PURGE_BATCH_SIZE, purgeExpiredAuthData } from '../mcp/oauth-purge';
import { sendDueReminders, TIME_BUDGET_MS as PUSH_TIME_BUDGET_MS } from '../push/reminder-job';
import { createCronBudget, type CronBudget, type CronCost, type CronReserve } from './cron-budget';
import { GUEST_CLEANUP_BATCH, removeInactiveGuests } from './inactive-guest-cleanup';
import { deleteOrphanEvidence, EVIDENCE_GC_PAGES_PER_RUN } from './orphan-evidence-cleanup';

export interface CronJob {
  name: string;
  run: (budget: CronBudget) => Promise<unknown>;
}

/**
 * Held back from push reminders for the jobs after them (OAuth purge, guest cleanup, evidence GC). Enough
 * for a full guest batch (51 D1 queries) plus a few evidence owner lookups, a small OAuth batch, and a
 * minute of wall clock.
 */
export const CLEANUP_RESERVE: CronReserve = { d1Queries: 100, subrequests: 1_000, timeMs: 60_000 };

/** The two D1 purges (expired login requests and sessions). */
const OAUTH_D1_QUERIES = 2;
/** CACHE cursor read and write/delete, plus slack for the provider's own bookkeeping. */
const OAUTH_OVERHEAD_NET = 4;
/**
 * Worst case per unit of OAuth batch (record read, owner read, revoke), for both the grant and the token
 * phase. All of it is KV. Used only to size the batch so even the worst case fits what is left of the budget.
 */
const OAUTH_NET_PER_ITEM = 10;
/** Estimate per OAuth record checked: its KV read plus the read of its client (grant) or grant (token). */
const OAUTH_NET_PER_CHECKED = 2;
/** Extra estimate per record purged: revocation lists and deletes the grant's tokens and the record. */
const OAUTH_NET_PER_PURGED = 4;
/** KV list page size used by the OAuth sweep. */
const OAUTH_LIST_PAGE = 1000;

/** Worst-case cost reserved for an OAuth purge batch of `batch` items. */
const oauthWorstCase = (batch: number): Required<CronCost> => ({ d1: OAUTH_D1_QUERIES, net: OAUTH_OVERHEAD_NET + batch * OAUTH_NET_PER_ITEM });

/**
 * Cost charged for one OAuth purge batch: proportional to what it actually checked and purged (KV list
 * pages included), capped at the worst case reserved for `batch`, so an idle sweep does not starve the jobs
 * after it.
 */
export function oauthPurgeCost(result: PurgeResult, batch: number): Required<CronCost> {
  const listPages = Math.ceil(result.grantsChecked / OAUTH_LIST_PAGE) + Math.ceil(result.tokensChecked / OAUTH_LIST_PAGE) + 2;
  const net = OAUTH_OVERHEAD_NET + listPages
    + (result.grantsChecked + result.tokensChecked) * OAUTH_NET_PER_CHECKED
    + (result.grantsPurged + result.tokensPurged) * OAUTH_NET_PER_PURGED;
  return { d1: OAUTH_D1_QUERIES, net: Math.min(net, oauthWorstCase(batch).net) };
}

/** The cron jobs, in run order. */
export function scheduledJobs(env: Env): CronJob[] {
  return [
    {
      name: 'push-reminders',
      // The job charges every D1 query and push itself, as it goes, so a failure mid-run is charged exactly.
      run: (budget) => sendDueReminders(env, { budget: budget.reserving(CLEANUP_RESERVE), timeBudgetMs: PUSH_TIME_BUDGET_MS }),
    },
    {
      name: 'oauth-purge',
      run: async (budget) => {
        if (budget.remainingD1Queries() < OAUTH_D1_QUERIES) return { deferred: true };
        const netLeft = budget.remainingSubrequests() - OAUTH_D1_QUERIES - OAUTH_OVERHEAD_NET;
        const batch = Math.min(OAUTH_PURGE_BATCH_SIZE, Math.floor(netLeft / OAUTH_NET_PER_ITEM));
        if (batch <= 0) return { deferred: true };
        let result: PurgeResult | undefined;
        try {
          result = await purgeExpiredAuthData(env, new Date(), batch);
          return result;
        } finally {
          // On failure the work done is unknown, so the worst case reserved for this batch is charged.
          budget.charge(result ? oauthPurgeCost(result, batch) : oauthWorstCase(batch));
        }
      },
    },
    // Abuse/cost hygiene: abandoned guests and evidence images that were never submitted.
    { name: 'guest-cleanup', run: (budget) => removeInactiveGuests(env, new Date(), GUEST_CLEANUP_BATCH, budget) },
    { name: 'evidence-gc', run: (budget) => deleteOrphanEvidence(env, new Date(), EVIDENCE_GC_PAGES_PER_RUN, budget) },
    // ai-tutor insights (retention → analyzer → proposals). Last, so it only uses what the jobs above left;
    // a no-op that charges nothing while INSIGHTS_MODE is off.
    { name: 'insights-pipeline', run: (budget) => runInsightsPipeline(env, budget, new Date()) },
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
