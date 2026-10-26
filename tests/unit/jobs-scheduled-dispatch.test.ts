import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronBudget, CRON_SUBREQUEST_BUDGET, type CronBudget } from '../../src/lib/jobs/cron-budget';
import { oauthPurgeSubrequests, runCronJobs, scheduledJobs, type CronJob } from '../../src/lib/jobs/scheduled-jobs';
import { purgeExpiredAuthData } from '../../src/lib/mcp/oauth-purge';

// The real module pulls in the OAuth provider (cloudflare:* imports), which Node cannot load.
vi.mock('../../src/lib/mcp/oauth-purge', () => ({ OAUTH_PURGE_BATCH_SIZE: 500, purgeExpiredAuthData: vi.fn() }));

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
    const job = (name: string, cost: number): CronJob => ({
      name,
      run: async (budget: CronBudget) => {
        seen[name] = budget.remainingSubrequests();
        budget.charge(cost);
      },
    });
    const late = vi.fn(async () => undefined);
    await runCronJobs('t', [job('first', 60), job('second', 40), { name: 'late', run: late }], createCronBudget({ subrequests: 100 }));
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

  it('defers the push job when the remaining subrequests cannot cover one send', async () => {
    const budget = createCronBudget({ subrequests: 15 });
    const push = scheduledJobs({} as Env)[0];
    // 15 subrequests cannot cover the push overhead plus one send: the job defers without touching D1.
    expect(await push.run(budget)).toEqual({ deferred: true });
    expect(budget.remainingSubrequests()).toBe(15);
  });

  it('keeps the per-tick budget under the 1,000 D1 queries a Worker invocation may make', () => {
    expect(CRON_SUBREQUEST_BUDGET).toBeLessThan(1000);
    expect(createCronBudget().remainingSubrequests()).toBe(CRON_SUBREQUEST_BUDGET);
  });

  describe('oauth purge charge', () => {
    const oauthJob = () => scheduledJobs({} as Env)[1];
    const idle = { grantsChecked: 3, grantsPurged: 0, tokensChecked: 5, tokensPurged: 0, done: true };

    it('charges in proportion to what the batch checked and purged, not the worst case', async () => {
      vi.mocked(purgeExpiredAuthData).mockResolvedValueOnce(idle);
      const budget = createCronBudget({ subrequests: 900 });
      await oauthJob().run(budget);
      // 6 overhead + 2 list pages per phase + 8 records checked x 2.
      expect(900 - budget.remainingSubrequests()).toBe(6 + 4 + 16);
      // The batch was sized so even its worst case fits the budget.
      const batch = vi.mocked(purgeExpiredAuthData).mock.calls.at(-1)?.[2] ?? 0;
      expect(6 + batch * 10).toBeLessThanOrEqual(900);
      // An idle sweep leaves almost everything for the cleanup jobs that run after it.
      expect(budget.remainingSubrequests()).toBeGreaterThan(850);
    });

    it('grows with purged records but never above the worst case reserved for the batch', () => {
      const busy = { grantsChecked: 40, grantsPurged: 40, tokensChecked: 40, tokensPurged: 40, done: false };
      expect(oauthPurgeSubrequests(busy, 40)).toBe(6 + 40 * 10);
      expect(oauthPurgeSubrequests({ ...idle, grantsPurged: 2 }, 100)).toBe(oauthPurgeSubrequests(idle, 100) + 2 * 4);
    });

    it('charges the reserved worst case when the purge fails', async () => {
      vi.mocked(purgeExpiredAuthData).mockRejectedValueOnce(new Error('kv down'));
      const budget = createCronBudget({ subrequests: 106 });
      await expect(oauthJob().run(budget)).rejects.toThrow('kv down');
      // batch = floor((106 - 6) / 10) = 10, so 6 + 10 x 10 is charged.
      expect(budget.remainingSubrequests()).toBe(0);
    });
  });
});
