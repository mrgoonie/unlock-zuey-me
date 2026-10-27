/**
 * Persists an evaluation and its consequences. One atomic batch writes the evaluation, the run status, the
 * XP ledger row (passed only; keyed by mission, so a mission pays XP once per learner: retries and later
 * passing runs of the same mission earn 0 XP) and competency EMAs (graded only, and only until the mission's
 * first pass: once a learner has passed a mission, later evaluations of it are still graded and shown but
 * no longer move competency scores, so repeating an easy mission cannot inflate them).
 * The batch is guarded on the claim: the evaluation is inserted only while the run is still `evaluating` at
 * the claimed `rev`, and every other write requires that evaluation row. A stale evaluation that finishes
 * after the run was re-claimed (e.g. a retry of a stuck evaluation) therefore writes nothing and gets a
 * conflict, so it can neither overwrite the newer result nor apply competency scores twice.
 * Badges, streak and level are derived afterwards and the earned rewards are stored for idempotent replay.
 * The no-hint XP bonus and badge count the hints of runs abandoned earlier in the attempt (carried-penalties.ts).
 */
import type { Mission } from '../content/schema';
import { newId, nowIso } from '../db/ids';
import { insertEvaluationIfClaimedStatement, saveEvaluationRewards } from '../db/evaluation-repository';
import { competencyRows, sumXp, upsertCompetencyIfEvaluatedStatement } from '../db/progress-queries';
import { findRun } from '../db/run-repository';
import { recordEventSafe } from '../observer/events';
import { loadStreak } from './activity';
import { grantEligibleBadges } from './badges';
import { carriedHintsUsed } from './carried-penalties';
import { RunConflictError, runNotFound } from './errors';
import type { EvaluationDraft } from './evaluate-submission';
import { transition } from './mission-state-machine';
import { competencyAverages, emaUpdate } from './scoring';
import type { Evaluation, LearnerContext, MissionRun, Rewards, Source } from './types';
import { computeMissionXp, levelForXp } from './xp-and-levels';

export const MISSION_PASS_XP_REASON = 'mission_pass';

/** True when the learner already has a passing evaluation of this mission (any run). */
export async function hasPassedMission(db: D1Database, learnerId: string, missionId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS x FROM evaluations e JOIN mission_runs r ON r.id = e.run_id
      WHERE e.learner_id = ? AND r.mission_id = ? AND e.status = 'passed' LIMIT 1`,
  ).bind(learnerId, missionId).first<{ x: number }>();
  return row !== null;
}

export async function finalizeEvaluation(env: Env, input: {
  /** The run as claimed by the submit batch: status `evaluating` at the post-claim `rev`. */
  learner: LearnerContext; run: MissionRun; mission: Mission; submissionId: string; draft: EvaluationDraft; source: Source; now: Date;
}): Promise<{ run: MissionRun; evaluation: Evaluation; rewards: Rewards }> {
  const { learner, run, mission, draft, now } = input;
  const db = env.DB;
  const at = nowIso(now);
  const evaluation: Evaluation = { ...draft, id: newId('evl'), runId: run.id, submissionId: input.submissionId, createdAt: at };
  const passed = draft.status === 'passed';
  const nextStatus = draft.status === 'failed' ? transition('evaluating', { type: 'grading_failed' }) : transition('evaluating', { type: 'graded', passed });

  const xpBefore = await sumXp(db, learner.id);
  // Hints used in runs abandoned earlier in this attempt count too, so abandoning cannot restore the no-hint bonus.
  const hintsUsed = passed ? run.hintsUsed + await carriedHintsUsed(db, learner.id, mission.id) : run.hintsUsed;
  const xp = passed ? computeMissionXp({ estimatedMinutes: mission.estimated_minutes, hintsUsed, confidence: run.confidence, score: draft.score }) : null;

  // Every write after the first requires the evaluation row, which exists only if the claim still holds.
  const ifEvaluated = 'EXISTS (SELECT 1 FROM evaluations WHERE id = ?)';
  const statements: D1PreparedStatement[] = [
    insertEvaluationIfClaimedStatement(db, learner.id, evaluation, run.rev),
    db.prepare(
      `UPDATE mission_runs SET status = ?, completed_at = ?, rev = rev + 1, updated_at = ?
       WHERE id = ? AND learner_id = ? AND status = 'evaluating' AND rev = ? AND ${ifEvaluated}`,
    ).bind(nextStatus, nextStatus === 'completed' ? at : null, at, run.id, learner.id, run.rev, evaluation.id),
  ];
  const xpIndex = statements.length;
  if (xp) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO xp_ledger (id, learner_id, amount, reason, ref, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${ifEvaluated}`,
    ).bind(newId('xp'), learner.id, xp.total, MISSION_PASS_XP_REASON, mission.id, at, evaluation.id));
  }
  if (draft.status !== 'failed' && !(await hasPassedMission(db, learner.id, mission.id))) {
    const current = new Map((await competencyRows(db, learner.id)).map((c) => [c.competency, c]));
    for (const [competency, observed] of competencyAverages(draft.criteria)) {
      const prev = current.get(competency);
      const next = emaUpdate({ score: prev?.score ?? 0, evidenceCount: prev?.evidence_count ?? 0 }, observed);
      statements.push(upsertCompetencyIfEvaluatedStatement(db, learner.id, competency, next.score, next.evidenceCount, at, evaluation.id));
    }
  }
  const results = await db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    const current = await findRun(db, learner.id, run.id);
    if (!current) throw runNotFound();
    throw new RunConflictError(current, 'Bài làm đã được chấm lại ở lượt khác. Đã tải kết quả mới nhất.');
  }
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
      streakDays: streak.current, pass: { missionId: mission.id, hintsUsed, confidence: run.confidence, score: draft.score },
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
