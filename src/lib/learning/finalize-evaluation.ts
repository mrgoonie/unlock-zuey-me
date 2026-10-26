/**
 * Persists an evaluation and its consequences. One atomic batch writes the evaluation, the run status, the
 * XP ledger row (passed only; unique per run so retries never pay twice) and competency EMAs (graded only).
 * Badges, streak and level are derived afterwards and the earned rewards are stored for idempotent replay.
 */
import type { Mission } from '../content/schema';
import { newId, nowIso } from '../db/ids';
import { insertEvaluationStatement, saveEvaluationRewards } from '../db/evaluation-repository';
import { competencyRows, sumXp, upsertCompetencyStatement } from '../db/progress-queries';
import { findRun } from '../db/run-repository';
import { recordEventSafe } from '../observer/events';
import { loadStreak } from './activity';
import { grantEligibleBadges } from './badges';
import { runNotFound } from './errors';
import type { EvaluationDraft } from './evaluate-submission';
import { transition } from './mission-state-machine';
import { competencyAverages, emaUpdate } from './scoring';
import type { Evaluation, LearnerContext, MissionRun, Rewards, Source } from './types';
import { computeMissionXp, levelForXp } from './xp-and-levels';

export const MISSION_PASS_XP_REASON = 'mission_pass';

export async function finalizeEvaluation(env: Env, input: {
  learner: LearnerContext; run: MissionRun; mission: Mission; submissionId: string; draft: EvaluationDraft; source: Source; now: Date;
}): Promise<{ run: MissionRun; evaluation: Evaluation; rewards: Rewards }> {
  const { learner, run, mission, draft, now } = input;
  const db = env.DB;
  const at = nowIso(now);
  const evaluation: Evaluation = { ...draft, id: newId('evl'), runId: run.id, submissionId: input.submissionId, createdAt: at };
  const passed = draft.status === 'passed';
  const nextStatus = draft.status === 'failed' ? transition('evaluating', { type: 'grading_failed' }) : transition('evaluating', { type: 'graded', passed });

  const xpBefore = await sumXp(db, learner.id);
  const xp = passed ? computeMissionXp({ estimatedMinutes: mission.estimated_minutes, hintsUsed: run.hintsUsed, confidence: run.confidence, score: draft.score }) : null;

  const statements: D1PreparedStatement[] = [
    insertEvaluationStatement(db, learner.id, evaluation),
    db.prepare(
      `UPDATE mission_runs SET status = ?, completed_at = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND learner_id = ? AND status = 'evaluating'`,
    ).bind(nextStatus, nextStatus === 'completed' ? at : null, at, run.id, learner.id),
  ];
  const xpIndex = statements.length;
  if (xp) {
    statements.push(db.prepare('INSERT OR IGNORE INTO xp_ledger (id, learner_id, amount, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId('xp'), learner.id, xp.total, MISSION_PASS_XP_REASON, run.id, at));
  }
  if (draft.status !== 'failed') {
    const current = new Map((await competencyRows(db, learner.id)).map((c) => [c.competency, c]));
    for (const [competency, observed] of competencyAverages(draft.criteria)) {
      const prev = current.get(competency);
      const next = emaUpdate({ score: prev?.score ?? 0, evidenceCount: prev?.evidence_count ?? 0 }, observed);
      statements.push(upsertCompetencyStatement(db, learner.id, competency, next.score, next.evidenceCount, at));
    }
  }
  const results = await db.batch(statements);
  const xpGained = xp && (results[xpIndex]?.meta.changes ?? 0) > 0 ? xp.total : 0;

  const ev = { learnerId: learner.id, runId: run.id, missionId: mission.id, missionVersion: run.missionVersion, source: input.source };
  await recordEventSafe(db, draft.status === 'failed'
    ? { ...ev, name: 'evaluation.failed', props: { reason: 'ai_unavailable' } }
    : { ...ev, name: 'evaluation.completed', props: { status: draft.status, score: draft.score, mode: draft.mode, model: draft.graderModel } });
  if (xpGained > 0 && xp) {
    await recordEventSafe(db, { ...ev, name: 'xp.granted', props: { amount: xp.total, base: xp.base, noHintBonus: xp.noHintBonus, calibrationBonus: xp.calibrationBonus } });
  }

  const streak = await loadStreak(db, learner, now);
  const newBadges = passed
    ? await grantEligibleBadges(env, learner, {
      streakDays: streak.current, pass: { missionId: mission.id, hintsUsed: run.hintsUsed, confidence: run.confidence, score: draft.score },
      ref: input.submissionId, source: input.source, runId: run.id, missionId: mission.id, now,
    })
    : [];

  const xpTotal = xpBefore + xpGained;
  const level = levelForXp(xpTotal);
  const levelBefore = levelForXp(xpBefore);
  if (level.id !== levelBefore.id) await recordEventSafe(db, { ...ev, name: 'level.up', props: { from: levelBefore.id, to: level.id } });

  try {
    await saveEvaluationRewards(db, evaluation.id, { xpGained, newBadges });
  } catch (err) {
    console.error('saveEvaluationRewards failed', err);
  }
  const updated = await findRun(db, learner.id, run.id);
  if (!updated) throw runNotFound();
  return { run: updated, evaluation, rewards: { xpGained, xpTotal, level, newBadges, streak } };
}
