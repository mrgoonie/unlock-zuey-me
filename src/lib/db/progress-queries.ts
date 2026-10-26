/** Read models for progress, badges and certificates (always scoped by learner id). */
import type { CompetencyId } from '../content/schema';

export async function sumXp(db: D1Database, learnerId: string, sinceIso?: string): Promise<number> {
  const row = sinceIso
    ? await db.prepare('SELECT COALESCE(SUM(amount), 0) AS xp FROM xp_ledger WHERE learner_id = ? AND created_at >= ?').bind(learnerId, sinceIso).first<{ xp: number }>()
    : await db.prepare('SELECT COALESCE(SUM(amount), 0) AS xp FROM xp_ledger WHERE learner_id = ?').bind(learnerId).first<{ xp: number }>();
  return Number(row?.xp ?? 0);
}

export async function completedMissionIds(db: D1Database, learnerId: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT DISTINCT mission_id FROM mission_runs WHERE learner_id = ? AND status = 'completed'`)
    .bind(learnerId).all<{ mission_id: string }>();
  return results.map((r) => r.mission_id);
}

export async function labsDone(db: D1Database, learnerId: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT DISTINCT lab_id FROM lab_runs WHERE learner_id = ? ORDER BY lab_id')
    .bind(learnerId).all<{ lab_id: string }>();
  return results.map((r) => r.lab_id);
}

export interface CompetencyRow {
  competency: CompetencyId;
  score: number;
  evidence_count: number;
}

export async function competencyRows(db: D1Database, learnerId: string): Promise<CompetencyRow[]> {
  const { results } = await db.prepare('SELECT competency, score, evidence_count FROM competency_scores WHERE learner_id = ?')
    .bind(learnerId).all<CompetencyRow>();
  return results;
}

/** Upserts a competency EMA only if the given evaluation row exists (same batch as its guarded insert). */
export function upsertCompetencyIfEvaluatedStatement(
  db: D1Database, learnerId: string, competency: CompetencyId, score: number, evidenceCount: number, nowIso: string, evaluationId: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO competency_scores (learner_id, competency, score, evidence_count, updated_at)
     SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM evaluations WHERE id = ?)
     ON CONFLICT (learner_id, competency) DO UPDATE SET score = excluded.score, evidence_count = excluded.evidence_count, updated_at = excluded.updated_at`,
  ).bind(learnerId, competency, score, evidenceCount, nowIso, evaluationId);
}

export async function badgeGrants(db: D1Database, learnerId: string): Promise<Array<{ badge_id: string; granted_at: string }>> {
  const { results } = await db.prepare('SELECT badge_id, granted_at FROM badge_grants WHERE learner_id = ? ORDER BY granted_at')
    .bind(learnerId).all<{ badge_id: string; granted_at: string }>();
  return results;
}

export async function conceptsSeenCount(db: D1Database, learnerId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM concept_views WHERE learner_id = ?').bind(learnerId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function activityDaysSince(db: D1Database, learnerId: string, sinceDay: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT day FROM activity_days WHERE learner_id = ? AND day >= ?')
    .bind(learnerId, sinceDay).all<{ day: string }>();
  return results.map((r) => r.day);
}

export async function insertActivityDay(db: D1Database, learnerId: string, day: string): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO activity_days (learner_id, day) VALUES (?, ?)').bind(learnerId, day).run();
}
