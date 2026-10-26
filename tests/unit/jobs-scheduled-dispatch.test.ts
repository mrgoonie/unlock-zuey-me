import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronBudget, type CronBudget } from '../../src/lib/jobs/cron-budget';
import { CLEANUP_RESERVE, oauthPurgeCost, runCronJobs, scheduledJobs, type CronJob } from '../../src/lib/jobs/scheduled-jobs';
import { purgeExpiredAuthData } from '../../src/lib/mcp/oauth-purge';
import { sendDueReminders } from '../../src/lib/push/reminder-job';

// The real module pulls in the OAuth provider (cloudflare:* imports), which Node cannot load.
vi.mock('../../src/lib/mcp/oauth-purge', () => ({ OAUTH_PURGE_BATCH_SIZE: 500, purgeExpiredAuthData: vi.fn() }));
vi.mock('../../src/lib/push/reminder-job', () => ({ TIME_BUDGET_MS: 300_000, sendDueReminders: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe('cron dispatcher', () => {
  it('runs push reminders first, then the cleanup jobs', () => {
    expect(scheduledJobs({} as Env).map((j) => j.name)).toEqual(['push-reminders', 'oauth-purge', 'guest-cleanup', 'evidence-gc']);
  });

  it('runs jobs one at a time in order, never overlapping', async () => {
    const log: string[] = [];
    const job = (name: string): CronJob => ({
      name,
      run: async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`${name}:end`);
      },
    });
    await runCronJobs('*/15 * * * *', [job('a'), job('b'), job('c')], createCronBudget());
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('isolates failures: a throwing job is logged and the next job still runs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ran: string[] = [];
    await runCronJobs('*/15 * * * *', [
      { name: 'boom', run: async () => { ran.push('boom'); throw new Error('kaput'); } },
      { name: 'after', run: async () => { ran.push('after'); } },
    ], createCronBudget());
    expect(ran).toEqual(['boom', 'after']);
    expect(error).toHaveBeenCalledWith('cron */15 * * * * job boom failed', expect.any(Error));
  });

  it('shares one budget: jobs see what earlier jobs used and later jobs are deferred once it is spent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: Record<string, number> = {};
    const job = (name: string, d1: number): CronJob => ({
      name,
      run: async (budget: CronBudget) => {
        seen[name] = budget.remainingD1Queries();
        budget.charge({ d1 });
      },
    });
    const late = vi.fn(async () => undefined);
    await runCronJobs('t', [job('first', 60), job('second', 40), { name: 'late', run: late }], createCronBudget({ d1Queries: 100 }));
    expect(seen).toEqual({ first: 100, second: 40 });
    expect(late).not.toHaveBeenCalled();
  });

  it('defers remaining jobs when the time budget runs out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let now = 0;
    const budget = createCronBudget({ timeMs: 1000, clock: () => now });
    const late = vi.fn(async () => undefined);
    await runCronJobs('t', [{ name: 'slow', run: async () => { now = 1000; } }, { name: 'late', run: late }], budget);
    expect(late).not.toHaveBeenCalled();
  });

  describe('cleanup reserve', () => {
    it('hands push reminders only the budget above the cleanup reserve', async () => {
      let pushView: CronBudget | undefined;
      vi.mocked(sendDueReminders).mockImplementationOnce(async (_env, deps) => {
        pushView = deps?.budget;
        return { sent: 0, removed: 0, failed: 0, skipped: 0, deferred: false };
      });
      const budget = createCronBudget({ d1Queries: 900, subrequests: 9000, timeMs: 480_000, clock: () => 0 });
      await scheduledJobs({} as Env)[0].run(budget);
      expect(pushView?.remainingD1Queries()).toBe(900 - CLEANUP_RESERVE.d1Queries);
      expect(pushView?.remainingSubrequests()).toBe(9000 - CLEANUP_RESERVE.subrequests);
      expect(pushView?.remainingMs()).toBe(480_000 - CLEANUP_RESERVE.timeMs);
      // Charges through the view land on the shared budget.
      pushView?.charge({ d1: 10, net: 5 });
      expect(budget.remainingD1Queries()).toBe(890);
      expect(budget.remainingSubrequests()).toBe(8985);
    });

    it('lets every cleanup job run even when push reminders use everything they are allowed', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const budget = createCronBudget();
      const ran: string[] = [];
      const greedyPush: CronJob = {
        name: 'push',
        run: async (b) => {
          // Spend the whole push view, the way a busy reminder quarter hour would.
          const view = b.reserving(CLEANUP_RESERVE);
          view.charge({ d1: view.remainingD1Queries(), net: view.remainingSubrequests() - view.remainingD1Queries() });
          expect(view.exhausted()).toBe(true);
        },
      };
      const cleanup = (name: string): CronJob => ({ name, run: async (b) => { ran.push(name); b.charge({ d1: 30, net: 300 }); } });
      await runCronJobs('t', [greedyPush, cleanup('oauth'), cleanup('guests'), cleanup('evidence')], budget);
      expect(ran).toEqual(['oauth', 'guests', 'evidence']);
      expect(budget.remainingD1Queries()).toBe(CLEANUP_RESERVE.d1Queries - 90);
    });
  });

  describe('oauth purge charge', () => {
    const oauthJob = () => scheduledJobs({} as Env)[1];
    const idle = { grantsChecked: 3, grantsPurged: 0, tokensChecked: 5, tokensPurged: 0, done: true };

    it('charges in proportion to what the batch checked and purged, not the worst case', async () => {
      vi.mocked(purgeExpiredAuthData).mockResolvedValueOnce(idle);
      const budget = createCronBudget({ subrequests: 900 });
      await oauthJob().run(budget);
      // 2 D1 purges; KV: 4 overhead + 2 list pages per phase + 8 records checked x 2.
      expect(900 - budget.remainingD1Queries()).toBe(2);
      expect(900 - budget.remainingSubrequests()).toBe(2 + 4 + 4 + 16);
      // The batch was sized so even its worst case fits the budget.
      const batch = vi.mocked(purgeExpiredAuthData).mock.calls.at(-1)?.[2] ?? 0;
      expect(2 + 4 + batch * 10).toBeLessThanOrEqual(900);
      // An idle sweep leaves almost everything for the cleanup jobs that run after it.
      expect(budget.remainingSubrequests()).toBeGreaterThan(850);
    });

    it('grows with purged records but never above the worst case reserved for the batch', () => {
      const busy = { grantsChecked: 40, grantsPurged: 40, tokensChecked: 40, tokensPurged: 40, done: false };
      expect(oauthPurgeCost(busy, 40)).toEqual({ d1: 2, net: 4 + 40 * 10 });
      expect(oauthPurgeCost({ ...idle, grantsPurged: 2 }, 100).net).toBe(oauthPurgeCost(idle, 100).net + 2 * 4);
    });

    it('charges the reserved worst case when the purge fails', async () => {
      vi.mocked(purgeExpiredAuthData).mockRejectedValueOnce(new Error('kv down'));
      const budget = createCronBudget({ subrequests: 106 });
      await expect(oauthJob().run(budget)).rejects.toThrow('kv down');
      // batch = floor((106 - 2 - 4) / 10) = 10, so 2 D1 + 4 + 10 x 10 KV is charged.
      expect(budget.remainingSubrequests()).toBe(0);
    });

    it('defers without touching KV when no batch fits', async () => {
      vi.mocked(purgeExpiredAuthData).mockClear();
      const budget = createCronBudget({ subrequests: 15 });
      expect(await oauthJob().run(budget)).toEqual({ deferred: true });
      expect(purgeExpiredAuthData).not.toHaveBeenCalled();
    });
  });
});
