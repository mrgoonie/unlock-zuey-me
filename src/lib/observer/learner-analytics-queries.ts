/**
 * Consent-gated analytics for one learner: mission funnel, hint dependence, scores and calibration,
 * competencies, time to first verified win. Every statement joins through consentJoin, so a learner
 * without consent yields empty results here (queries.ts turns that into not_found).
 */
import { getMission } from '../content/loader';
import { parseJson } from '../db/ids';
import type { CriterionResult } from '../learning/types';
import { CONSENTED_LEARNER, consentJoin } from './consent-gate';
import type { CompetencyScore, EvaluationSummary, FirstWin, MissionFunnel, RunHints } from './observer-types';

const STEP_KEY = `COALESCE(json_extract(e.props_json, '$.stepId'), json_extract(e.props_json, '$.step_id'), json_extract(e.props_json, '$.step'))`;

export async function getMissionFunnel(db: D1Database, learnerId: string): Promise<MissionFunnel[]> {
  const runs = await db.prepare(
    `SELECT r.mission_id, COUNT(*) AS started,
       SUM(EXISTS (SELECT 1 FROM evidence_submissions s WHERE s.run_id = r.id)) AS submitted,
       SUM(EXISTS (SELECT 1 FROM evaluations v WHERE v.run_id = r.id AND v.status = 'passed')) AS passed
     FROM mission_runs r ${consentJoin('r')} WHERE r.learner_id = ? GROUP BY r.mission_id ORDER BY MIN(r.started_at)`,
  ).bind(learnerId).all<{ mission_id: string; started: number; submitted: number; passed: number }>();
  if (!runs.results.length) return [];

  const steps = await db.prepare(
    `SELECT e.mission_id, ${STEP_KEY} AS step_id, e.name, COUNT(DISTINCT COALESCE(e.run_id, e.id)) AS n
     FROM events e ${consentJoin('e')}
     WHERE e.learner_id = ? AND e.name IN ('mission.step_viewed', 'mission.step_completed') AND e.mission_id IS NOT NULL
     GROUP BY e.mission_id, step_id, e.name`,
  ).bind(learnerId).all<{ mission_id: string; step_id: string | null; name: string; n: number }>();

  return runs.results.map((r) => {
    const mission = getMission(r.mission_id);
    const counts = new Map<string, { viewed: number; completed: number }>();
    for (const s of steps.results) {
      if (s.mission_id !== r.mission_id || !s.step_id) continue;
      const c = counts.get(s.step_id) ?? { viewed: 0, completed: 0 };
      if (s.name === 'mission.step_viewed') c.viewed = Number(s.n);
      else c.completed = Number(s.n);
      counts.set(s.step_id, c);
    }
    // Authored step order first, then any step ids only seen in events (e.g. an older mission version).
    const ordered = (mission?.steps ?? []).map((st) => ({ id: st.id, title: st.title }));
    for (const id of counts.keys()) if (!ordered.some((o) => o.id === id)) ordered.push({ id, title: id });
    return {
      missionId: r.mission_id,
      title: mission?.title ?? r.mission_id,
      started: Number(r.started),
      steps: ordered.map((o) => ({ stepId: o.id, title: o.title, ...(counts.get(o.id) ?? { viewed: 0, completed: 0 }) })),
      submitted: Number(r.submitted),
      passed: Number(r.passed),
    };
  });
}

export async function getHintDependence(db: D1Database, learnerId: string): Promise<RunHints[]> {
  const rows = await db.prepare(
    `SELECT r.id, r.mission_id, r.started_at, r.status, r.hints_used, r.hint_max_level
     FROM mission_runs r ${consentJoin('r')} WHERE r.learner_id = ? ORDER BY r.started_at`,
  ).bind(learnerId).all<{ id: string; mission_id: string; started_at: string; status: string; hints_used: number; hint_max_level: number }>();
  return rows.results.map((r) => ({
    runId: r.id, missionId: r.mission_id, startedAt: r.started_at, status: r.status,
    hintsUsed: Number(r.hints_used), hintMaxLevel: Number(r.hint_max_level),
  }));
}

export async function getEvaluations(db: D1Database, learnerId: string): Promise<EvaluationSummary[]> {
  const rows = await db.prepare(
    `SELECT v.id, v.run_id, r.mission_id, v.status, v.score, v.criteria_json, v.created_at, r.confidence
     FROM evaluations v JOIN mission_runs r ON r.id = v.run_id ${consentJoin('v')}
     WHERE v.learner_id = ? ORDER BY v.created_at`,
  ).bind(learnerId).all<{
    id: string; run_id: string; mission_id: string; status: EvaluationSummary['status']; score: number;
    criteria_json: string; created_at: string; confidence: number | null;
  }>();
  return rows.results.map((r) => ({
    id: r.id, runId: r.run_id, missionId: r.mission_id, status: r.status, score: Number(r.score),
    confidence: r.confidence === null ? null : Number(r.confidence),
    criteria: parseJson<CriterionResult[]>(r.criteria_json, []), createdAt: r.created_at,
  }));
}

export async function getCompetencies(db: D1Database, learnerId: string): Promise<CompetencyScore[]> {
  const rows = await db.prepare(
    `SELECT c.competency, c.score, c.evidence_count FROM competency_scores c ${consentJoin('c')}
     WHERE c.learner_id = ? ORDER BY c.competency`,
  ).bind(learnerId).all<{ competency: string; score: number; evidence_count: number }>();
  return rows.results.map((r) => ({ competency: r.competency, score: Number(r.score), evidenceCount: Number(r.evidence_count) }));
}

export async function getFirstWin(db: D1Database, learnerId: string): Promise<FirstWin | null> {
  const row = await db.prepare(
    `SELECT l.created_at AS joined_at,
       (SELECT MIN(started_at) FROM mission_runs WHERE learner_id = l.id) AS first_start,
       (SELECT MIN(created_at) FROM evaluations WHERE learner_id = l.id AND status = 'passed') AS first_pass
     FROM learners l WHERE l.id = ? AND ${CONSENTED_LEARNER}`,
  ).bind(learnerId).first<{ joined_at: string; first_start: string | null; first_pass: string | null }>();
  if (!row) return null;
  const ms = row.first_start && row.first_pass ? Date.parse(row.first_pass) - Date.parse(row.first_start) : null;
  return { joinedAt: row.joined_at, firstStartAt: row.first_start, firstPassAt: row.first_pass, msFromFirstStart: ms };
}
