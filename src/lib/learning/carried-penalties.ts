/**
 * Reveal and hint penalties belong to the learner and the mission, not to one run, so "Bỏ lượt này" cannot
 * wash them out: a learner who saw an answer (or used hints) and then abandons and retries keeps them.
 *
 * The penalties of an attempt are those of every run abandoned since the learner last completed the mission
 * (a completed run already shows the whole key, and XP is paid once per mission, so a "Làm lại" after
 * completion starts a new attempt with nothing carried).
 *   - Reveals: a new run starts with the earlier reveals recorded and their answers, as originally given,
 *     filled in and locked. Grading therefore sees the same answer as if the learner had never abandoned.
 *   - Hints: hints used in those abandoned runs count with the graded run's own hints for the no-hint XP
 *     bonus and the no-hint badge. Each run keeps its own hints_used, so per-run analytics stay accurate.
 */
import type { Mission } from '../content/schema';
import { parseJson } from '../db/ids';
import { isAnswered, lockedFields, revealableEntry } from './answer-reveals';
import { validateStepAnswers } from './answers-validation';
import { splitRevealKey } from './reveal-keys';
import type { Answers } from './types';

/** Abandoned runs of the learner's current attempt at a mission (binds: learnerId, missionId, learnerId, missionId). */
const ATTEMPT_ABANDONED_RUNS = `FROM mission_runs
  WHERE learner_id = ? AND mission_id = ? AND status = 'abandoned'
    AND started_at > COALESCE(
      (SELECT MAX(completed_at) FROM mission_runs WHERE learner_id = ? AND mission_id = ? AND status = 'completed'), '')`;

export interface CarriedReveals {
  /** Reveal keys ("stepId:itemId") still valid for the current mission content, oldest first. */
  revealed: string[];
  /** Only the locked fields of those items, with the values the learner had when revealing. */
  answers: Answers;
}

/** Hints used in the abandoned runs of the learner's current attempt at the mission. */
export async function carriedHintsUsed(db: D1Database, learnerId: string, missionId: string): Promise<number> {
  const row = await db.prepare(`SELECT COALESCE(SUM(hints_used), 0) AS n ${ATTEMPT_ABANDONED_RUNS}`)
    .bind(learnerId, missionId, learnerId, missionId).first<{ n: number }>();
  const n = Number(row?.n ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Reveals (with their locked answers) of the abandoned runs of the learner's current attempt, to seed a new
 * run. The first run that revealed an item supplies its answer. An item that the current mission content no
 * longer has, can no longer reveal, or whose stored answer is no longer valid is skipped: it cannot be locked.
 */
export async function carriedReveals(db: D1Database, learnerId: string, mission: Mission): Promise<CarriedReveals> {
  const { results } = await db.prepare(
    `SELECT revealed_json, answers_json ${ATTEMPT_ABANDONED_RUNS}
       AND revealed_json IS NOT NULL AND revealed_json <> '[]'
     ORDER BY started_at, id`,
  ).bind(learnerId, mission.id, learnerId, mission.id).all<{ revealed_json: string; answers_json: string }>();

  const out: CarriedReveals = { revealed: [], answers: {} };
  for (const row of results) {
    const revealed = parseJson<unknown>(row.revealed_json, []);
    const answers = parseJson<Answers>(row.answers_json, {});
    if (!Array.isArray(revealed)) continue;
    for (const key of revealed) {
      if (typeof key !== 'string' || out.revealed.includes(key)) continue;
      const parts = splitRevealKey(key);
      const step = parts && mission.steps.find((s) => s.id === parts.stepId);
      if (!step || !parts || !revealableEntry(step, parts.itemId)) continue;
      const stored = answers[step.id] ?? {};
      const picked: Record<string, unknown> = {};
      for (const field of lockedFields(step, parts.itemId)) if (stored[field] !== undefined) picked[field] = stored[field];
      let clean: Answers[string];
      try {
        clean = validateStepAnswers(step, picked);
      } catch {
        continue; // The content changed since (e.g. an option was removed): this answer cannot be kept.
      }
      if (!isAnswered(step, parts.itemId, { [step.id]: clean })) continue;
      out.revealed.push(key);
      out.answers[step.id] = { ...out.answers[step.id], ...clean };
    }
  }
  return out;
}
