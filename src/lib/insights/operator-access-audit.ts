/**
 * Audit trail of operator access to one learner's ai-tutor detail (insight_access_audit). Every successful
 * drill-down view writes exactly one row; a failed gate writes none. The row is exported and erased with the
 * observed learner (LEARNER_TABLES).
 */
import { newId } from '../db/ids';
import { getLearnerReportsForOperator, type OperatorLearnerReports } from './operator-insight-queries';

export type InsightAccessAction = 'view_reports';

export interface InsightAccess {
  learnerId: string;
  actorId: string;
  action: InsightAccessAction;
  targetRef?: string | null;
}

/** Writes one audit row. Call only after the detail gate has passed. */
export async function recordInsightAccess(db: D1Database, access: InsightAccess, now: Date = new Date()): Promise<void> {
  await db.prepare(
    'INSERT INTO insight_access_audit (id, learner_id, actor_id, action, target_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(newId('iau'), access.learnerId, access.actorId, access.action, access.targetRef ?? null, now.toISOString()).run();
}

/**
 * The drill-down read used by both the admin page and the admin API: gate → audit row → reports.
 * Null (→ 404) when the gate fails, with no audit row. The audit insert is not best-effort: if it fails the
 * error propagates and nothing is shown, so no view can happen without a trail.
 */
export async function viewLearnerReportsAsOperator(
  db: D1Database, learnerId: string, actorId: string, now: Date = new Date(),
): Promise<OperatorLearnerReports | null> {
  const detail = await getLearnerReportsForOperator(db, learnerId, now);
  if (!detail) return null;
  await recordInsightAccess(db, { learnerId, actorId, action: 'view_reports', targetRef: `reports:${detail.reports.length}` }, now);
  return detail;
}
