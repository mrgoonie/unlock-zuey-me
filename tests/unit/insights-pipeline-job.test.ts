/** The insights-pipeline cron job: a free no-op with the flag off, ordered and isolated stages otherwise. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCronBudget } from '../../src/lib/jobs/cron-budget';
import { runInsightsPipeline, type InsightsPipelineStages } from '../../src/lib/insights/pipeline-job';
import type { InsightsStage } from '../../src/lib/insights/insight-types';

afterEach(() => vi.restoreAllMocks());

const NOW = new Date('2026-10-26T16:00:00.000Z');

function recordingStages(log: string[], over: Partial<InsightsPipelineStages> = {}): InsightsPipelineStages {
  const stage = (name: string): InsightsStage => async () => {
    log.push(name);
    return { name };
  };
  return { retention: stage('retention'), analyzer: stage('analyzer'), proposal: stage('proposal'), ...over };
}

describe('runInsightsPipeline', () => {
  it('returns flag_off without running a stage or charging the budget when the mode is off or unset', async () => {
    for (const env of [{}, { INSIGHTS_MODE: 'off' }, { INSIGHTS_MODE: 'bogus' }]) {
      const log: string[] = [];
      // A DB that throws on any use proves the job touches nothing.
      const poisoned = { ...env, DB: new Proxy({}, { get: () => { throw new Error('DB used'); } }) } as unknown as Env;
      const budget = createCronBudget({ d1Queries: 100, subrequests: 1000 });
      expect(await runInsightsPipeline(poisoned, budget, NOW, recordingStages(log))).toEqual({ skipped: 'flag_off' });
      expect(log).toEqual([]);
      expect(budget.remainingD1Queries()).toBe(100);
      expect(budget.remainingSubrequests()).toBe(1000);
    }
  });

  it('runs the real stubs with the default stages when enabled', async () => {
    const result = await runInsightsPipeline({ INSIGHTS_MODE: 'internal' } as Env, createCronBudget(), NOW);
    expect(result).toEqual({
      mode: 'internal',
      retention: { status: 'failed', error: expect.any(String) }, // the real retention stage needs env.DB
      analyzer: { status: 'failed', error: expect.any(String) }, // the real analyzer needs env.DB
      proposal: { status: 'ok', result: { stub: true } },
    });
  });

  it('runs retention, analyzer and proposal in order with the same budget and clock', async () => {
    const log: string[] = [];
    const seen: Array<[unknown, Date]> = [];
    const budget = createCronBudget();
    const spy: InsightsStage = async (_env, b, now) => {
      seen.push([b, now]);
      log.push('analyzer');
    };
    await runInsightsPipeline({ INSIGHTS_MODE: 'on' } as Env, budget, NOW, recordingStages(log, { analyzer: spy }));
    expect(log).toEqual(['retention', 'analyzer', 'proposal']);
    expect(seen).toEqual([[budget, NOW]]);
  });

  it('isolates a failing stage: it is logged and the next stage still runs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log: string[] = [];
    const result = await runInsightsPipeline({ INSIGHTS_MODE: 'on' } as Env, createCronBudget(), NOW, recordingStages(log, {
      analyzer: async () => { throw new Error('ai down'); },
    }));
    expect(log).toEqual(['retention', 'proposal']);
    expect(result).toMatchObject({ analyzer: { status: 'failed', error: 'ai down' }, proposal: { status: 'ok' } });
    expect(error).toHaveBeenCalledWith('insights-pipeline stage analyzer failed', expect.any(Error));
  });

  it('defers the remaining stages once the budget is spent', async () => {
    const log: string[] = [];
    const budget = createCronBudget({ d1Queries: 10 });
    const result = await runInsightsPipeline({ INSIGHTS_MODE: 'on' } as Env, budget, NOW, recordingStages(log, {
      retention: async (_env, b) => { log.push('retention'); b.charge({ d1: 10 }); },
    }));
    expect(log).toEqual(['retention']);
    expect(result).toMatchObject({ analyzer: { status: 'deferred' }, proposal: { status: 'deferred' } });
  });
});
