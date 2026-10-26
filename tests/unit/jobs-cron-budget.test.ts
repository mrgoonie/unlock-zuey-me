import { describe, expect, it } from 'vitest';
import { createCronBudget, CRON_D1_QUERY_BUDGET, CRON_SUBREQUEST_BUDGET } from '../../src/lib/jobs/cron-budget';

describe('cron budget', () => {
  it('stays under the Workers Paid per-invocation limits (1,000 D1 queries, 10,000 subrequests)', () => {
    expect(CRON_D1_QUERY_BUDGET).toBeLessThan(1000);
    expect(CRON_SUBREQUEST_BUDGET).toBeLessThan(10_000);
    const b = createCronBudget();
    expect(b.remainingD1Queries()).toBe(CRON_D1_QUERY_BUDGET);
    expect(b.remainingSubrequests()).toBe(CRON_SUBREQUEST_BUDGET);
  });

  it('counts D1 queries against both limits and network calls against subrequests only', () => {
    const b = createCronBudget({ d1Queries: 10, subrequests: 100 });
    b.charge({ d1: 3 });
    b.charge({ net: 20 });
    b.charge({ d1: 1, net: 5 });
    expect(b.remainingD1Queries()).toBe(6);
    expect(b.remainingSubrequests()).toBe(100 - 3 - 20 - 1 - 5);
  });

  it('affords a step only when it fits every budget', () => {
    const b = createCronBudget({ d1Queries: 2, subrequests: 10 });
    expect(b.canAfford({ d1: 2, net: 8 })).toBe(true);
    expect(b.canAfford({ d1: 3 })).toBe(false); // D1 limit
    expect(b.canAfford({ d1: 2, net: 9 })).toBe(false); // D1 queries are subrequests too
    expect(b.canAfford({ net: 10 })).toBe(true);
    expect(b.canAfford({ net: 11 })).toBe(false);
  });

  it('is exhausted once either request budget or the time budget is spent', () => {
    expect(createCronBudget({ d1Queries: 0 }).exhausted()).toBe(true);
    expect(createCronBudget({ subrequests: 0 }).exhausted()).toBe(true);
    let now = 0;
    const timed = createCronBudget({ timeMs: 100, clock: () => now });
    expect(timed.exhausted()).toBe(false);
    now = 100;
    expect(timed.exhausted()).toBe(true);
    expect(timed.canAfford({})).toBe(false);
    expect(timed.remainingMs()).toBe(0);
  });

  it('never reports a negative remainder and ignores negative charges', () => {
    const b = createCronBudget({ d1Queries: 1, subrequests: 1 });
    b.charge({ d1: -5, net: -5 });
    expect(b.remainingD1Queries()).toBe(1);
    b.charge({ d1: 3, net: 3 });
    expect(b.remainingD1Queries()).toBe(0);
    expect(b.remainingSubrequests()).toBe(0);
  });

  describe('reserving', () => {
    it('hides the reserve from the view while charges land on the shared budget', () => {
      let now = 0;
      const b = createCronBudget({ d1Queries: 100, subrequests: 1000, timeMs: 1000, clock: () => now });
      const view = b.reserving({ d1Queries: 20, subrequests: 200, timeMs: 300 });
      expect(view.remainingD1Queries()).toBe(80);
      expect(view.remainingSubrequests()).toBe(800);
      expect(view.remainingMs()).toBe(700);
      view.charge({ d1: 30, net: 70 });
      expect(b.remainingD1Queries()).toBe(70);
      expect(b.remainingSubrequests()).toBe(900);
      expect(view.remainingD1Queries()).toBe(50);
      now = 700;
      expect(view.exhausted()).toBe(true);
      expect(b.exhausted()).toBe(false);
    });

    it('refuses steps that would eat into the reserve', () => {
      const b = createCronBudget({ d1Queries: 10, subrequests: 100 });
      const view = b.reserving({ d1Queries: 4, subrequests: 10, timeMs: 0 });
      expect(view.canAfford({ d1: 6 })).toBe(true);
      expect(view.canAfford({ d1: 7 })).toBe(false);
      view.charge({ d1: 6 });
      expect(view.exhausted()).toBe(true);
      expect(b.canAfford({ d1: 4 })).toBe(true);
    });
  });
});
