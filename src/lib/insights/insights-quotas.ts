/**
 * Count quotas of the ai-tutor background analyzer, per UTC day:
 * - per learner: INSIGHTS_DAILY_ANALYSES_PER_LEARNER (default 12);
 * - per (learner, session): ANALYSES_PER_SESSION_PER_DAY (3);
 * - across all learners: INSIGHTS_DAILY_ANALYSES_GLOBAL (default 200).
 * An "analysis" is one model call that finished: a written report, or a window the model judged
 * `not_learning` (it costs the same call, so it counts too; those events share one processed_at).
 * These caps sit on top of the USD budgets that runAi enforces in the coaching pool.
 */
import { utcDay } from '../learning/learner-day';
import { ANALYSES_PER_SESSION_PER_DAY, dailyAnalysesGlobal, dailyAnalysesPerLearner } from './feature-flags';

export interface InsightsQuotaCaps {
  perLearner: number;
  perSession: number;
  global: number;
}

export function insightsQuotaCaps(env: Pick<Env, 'INSIGHTS_DAILY_ANALYSES_PER_LEARNER' | 'INSIGHTS_DAILY_ANALYSES_GLOBAL'>): InsightsQuotaCaps {
  return { perLearner: dailyAnalysesPerLearner(env), perSession: ANALYSES_PER_SESSION_PER_DAY, global: dailyAnalysesGlobal(env) };
}

/** [start, end) of the UTC day containing `now`, as ISO strings. */
export function utcDayBounds(now: Date): { start: string; end: string } {
  const start = `${utcDay(now)}T00:00:00.000Z`;
  return { start, end: new Date(Date.parse(start) + 86_400_000).toISOString() };
}

/** 00:05 UTC of the next day: when a learner whose daily quota is spent is retried. */
export function nextUtcDayRetryAt(now: Date): Date {
  return new Date(Date.parse(utcDayBounds(now).end) + 5 * 60_000);
}

/** SQL counting analyses in a UTC day, optionally filtered by learner and session. */
function countSql(byLearner: boolean, bySession: boolean): string {
  const r = [byLearner ? 'learner_id = ?' : '', bySession ? 'session_ref = ?' : '', 'created_at >= ?', 'created_at < ?'].filter(Boolean);
  const e = [byLearner ? 'learner_id = ?' : '', bySession ? 'session_ref = ?' : '',
    `status = 'skipped'`, `skip_reason = 'not_learning'`, 'processed_at >= ?', 'processed_at < ?'].filter(Boolean);
  return `SELECT (SELECT COUNT(*) FROM insight_reports WHERE ${r.join(' AND ')})
    + (SELECT COUNT(DISTINCT session_ref || '|' || processed_at) FROM insight_events WHERE ${e.join(' AND ')}) AS n`;
}

async function count(db: D1Database, now: Date, learnerId?: string, sessionRef?: string): Promise<number> {
  const { start, end } = utcDayBounds(now);
  const keys = [learnerId, sessionRef].filter((v): v is string => v !== undefined);
  const row = await db.prepare(countSql(learnerId !== undefined, sessionRef !== undefined))
    .bind(...keys, start, end, ...keys, start, end).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Analyses of one learner today (UTC). One D1 query. */
export const analysesToday = (db: D1Database, learnerId: string, now: Date): Promise<number> => count(db, now, learnerId);

/** Analyses of one learner's session today (UTC). One D1 query. */
export const analysesForSessionToday = (db: D1Database, learnerId: string, sessionRef: string, now: Date): Promise<number> =>
  count(db, now, learnerId, sessionRef);

/** Analyses across all learners today (UTC). One D1 query. */
export const analysesTodayGlobal = (db: D1Database, now: Date): Promise<number> => count(db, now);
