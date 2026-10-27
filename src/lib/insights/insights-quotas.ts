/**
 * Count quotas of the ai-tutor background analyzer, per UTC day:
 * - per learner: INSIGHTS_DAILY_ANALYSES_PER_LEARNER (default 12);
 * - per (learner, session): ANALYSES_PER_SESSION_PER_DAY (3);
 * - across all learners: INSIGHTS_DAILY_ANALYSES_GLOBAL (default 200).
 * An "analysis" is one model call that finished: a written report, or a window the model judged
 * `not_learning` (it costs the same call, so it counts too; those events share one processed_at).
 *
 * Both are counted from the processed queue rows (insight_events), never from insight_reports: a learner
 * can delete reports, but not the `done` / `skipped` rows behind them (deleting reports only removes queued
 * `pending` / `processing` turns), so deleting reports never frees the day's quota. Those rows live
 * QUEUE_RETENTION_DAYS (7), well past the UTC day they count for. Every event of one written report carries
 * its report_id.
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
  const where = [byLearner ? 'learner_id = ?' : '', bySession ? 'session_ref = ?' : '', 'processed_at >= ?', 'processed_at < ?',
    `((status = 'done' AND report_id IS NOT NULL) OR (status = 'skipped' AND skip_reason = 'not_learning'))`].filter(Boolean);
  return `SELECT COUNT(DISTINCT CASE WHEN status = 'done' THEN 'r|' || report_id ELSE 's|' || session_ref || '|' || processed_at END) AS n
    FROM insight_events WHERE ${where.join(' AND ')}`;
}

async function count(db: D1Database, now: Date, learnerId?: string, sessionRef?: string): Promise<number> {
  const { start, end } = utcDayBounds(now);
  const keys = [learnerId, sessionRef].filter((v): v is string => v !== undefined);
  const row = await db.prepare(countSql(learnerId !== undefined, sessionRef !== undefined))
    .bind(...keys, start, end).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Analyses of one learner today (UTC). One D1 query. */
export const analysesToday = (db: D1Database, learnerId: string, now: Date): Promise<number> => count(db, now, learnerId);

/** Analyses of one learner's session today (UTC). One D1 query. */
export const analysesForSessionToday = (db: D1Database, learnerId: string, sessionRef: string, now: Date): Promise<number> =>
  count(db, now, learnerId, sessionRef);

/** Analyses across all learners today (UTC). One D1 query. */
export const analysesTodayGlobal = (db: D1Database, now: Date): Promise<number> => count(db, now);
