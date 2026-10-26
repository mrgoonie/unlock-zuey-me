/**
 * Weekly/monthly recap. Competency deltas replay the learner's graded evaluations through the same EMA used
 * live (scores before the period vs now), so no score history table is needed.
 */
import { getBadge, getMission } from '../content/loader';
import type { CompetencyId } from '../content/schema';
import { parseJson } from '../db/ids';
import { listGradedEvaluations } from '../db/evaluation-repository';
import { sumXp } from '../db/progress-queries';
import { loadStreak } from './activity';
import type { RunDeps } from './mission-runs';
import { competencyAverages, emaUpdate } from './scoring';
import type { Answers, Evaluation, LearnerContext } from './types';

export const COMPETENCY_LABELS_VI: Record<CompetencyId, string> = {
  discover: 'Khám phá', describe: 'Diễn đạt', delegate: 'Giao việc', verify: 'Kiểm chứng', operate: 'Vận hành', reflect: 'Đúc kết',
};

export type RecapPeriod = 'week' | 'month';

export interface Recap {
  period: RecapPeriod;
  missionsCompleted: number;
  xpGained: number;
  competencyDeltas: Array<{ id: CompetencyId; before: number; after: number; delta: number }>;
  highlights: string[];
  reflections: string[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function replayCompetencies(evaluations: Evaluation[]): Map<CompetencyId, { score: number; evidenceCount: number }> {
  const state = new Map<CompetencyId, { score: number; evidenceCount: number }>();
  for (const e of evaluations) {
    for (const [c, observed] of competencyAverages(e.criteria)) state.set(c, emaUpdate(state.get(c) ?? { score: 0, evidenceCount: 0 }, observed));
  }
  return state;
}

export function competencyDeltas(evaluations: Evaluation[], sinceIso: string): Recap['competencyDeltas'] {
  const before = replayCompetencies(evaluations.filter((e) => e.createdAt < sinceIso));
  const after = replayCompetencies(evaluations);
  const out: Recap['competencyDeltas'] = [];
  for (const [id, a] of after) {
    const b = before.get(id)?.score ?? 0;
    if (round3(a.score - b) !== 0) out.push({ id, before: round3(b), after: round3(a.score), delta: round3(a.score - b) });
  }
  return out.sort((x, y) => y.delta - x.delta);
}

async function reflectionsSince(db: D1Database, learnerId: string, sinceIso: string): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT r.mission_id, s.answers_json FROM evidence_submissions s JOIN mission_runs r ON r.id = s.run_id
     WHERE s.learner_id = ? AND r.learner_id = ? AND s.created_at >= ? ORDER BY s.created_at DESC LIMIT 20`,
  ).bind(learnerId, learnerId, sinceIso).all<{ mission_id: string; answers_json: string }>();
  const out: string[] = [];
  for (const row of results) {
    const mission = getMission(row.mission_id);
    const answers = parseJson<Answers>(row.answers_json, {});
    for (const step of mission?.steps ?? []) {
      if (step.type !== 'reflection') continue;
      const v = answers[step.id]?.[step.field_id];
      if (typeof v === 'string' && v.trim()) out.push(v.trim().slice(0, 300));
    }
  }
  return [...new Set(out)].slice(0, 5);
}

export async function getRecap(deps: RunDeps, learner: LearnerContext, period: RecapPeriod): Promise<Recap> {
  const db = deps.env.DB;
  const now = deps.now?.() ?? new Date();
  const sinceIso = new Date(now.getTime() - (period === 'week' ? 7 : 30) * 86_400_000).toISOString();
  const [done, xpGained, evaluations, badges, streak, reflections] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM mission_runs WHERE learner_id = ? AND status = 'completed' AND completed_at >= ?`).bind(learner.id, sinceIso).first<{ n: number }>(),
    sumXp(db, learner.id, sinceIso),
    listGradedEvaluations(db, learner.id),
    db.prepare('SELECT badge_id FROM badge_grants WHERE learner_id = ? AND granted_at >= ?').bind(learner.id, sinceIso).all<{ badge_id: string }>(),
    loadStreak(db, learner, now),
    reflectionsSince(db, learner.id, sinceIso),
  ]);
  const missionsCompleted = Number(done?.n ?? 0);
  const deltas = competencyDeltas(evaluations, sinceIso);

  const highlights: string[] = [];
  if (missionsCompleted > 0) highlights.push(`Hoàn thành ${missionsCompleted} mission`);
  if (xpGained > 0) highlights.push(`Nhận ${xpGained} XP`);
  for (const b of badges.results) {
    const badge = getBadge(b.badge_id);
    if (badge) highlights.push(`Mở khoá huy hiệu ${badge.emoji} ${badge.name}`);
  }
  if (streak.current >= 2) highlights.push(`Chuỗi học ${streak.current} ngày`);
  const best = deltas[0];
  if (best && best.delta > 0) highlights.push(`Năng lực ${COMPETENCY_LABELS_VI[best.id]} tăng ${Math.round(best.delta * 100)} điểm`);

  return { period, missionsCompleted, xpGained, competencyDeltas: deltas, highlights, reflections };
}
