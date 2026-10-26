/** Hint requests: ladder order enforced on the run, coach answer stored, event recorded. */
import { getMission } from '../content/loader';
import type { AiDeps } from '../coach/ai-gateway';
import { generateHint } from '../coach/hint-coach';
import { newId, nowIso } from '../db/ids';
import { recordEventSafe } from '../observer/events';
import { findStep } from './answers-validation';
import { isOpen } from './mission-state-machine';
import { loadRun } from './mission-runs';
import { LearningError, type HintResult, type LearnerContext } from './types';

export async function requestHintImpl(
  deps: AiDeps, learner: LearnerContext, runId: string, stepId: string, level: HintResult['level'],
): Promise<HintResult> {
  if (![1, 2, 3, 4].includes(level)) throw new LearningError('invalid', 'Nấc gợi ý phải từ 1 đến 4.');
  const run = await loadRun(deps, learner, runId);
  if (!isOpen(run.status)) throw new LearningError('conflict', 'Mission này đã kết thúc, không cần gợi ý nữa.');
  const mission = getMission(run.missionId);
  if (!mission) throw new LearningError('unavailable', 'Mission này tạm thời không khả dụng.');
  const step = findStep(mission, stepId);
  const db = deps.env.DB;
  const now = deps.now?.() ?? new Date();

  // Ladder order: level n only after level n-1 was opened (checked atomically in the update).
  const unlocked = await db.prepare(
    `UPDATE mission_runs SET hint_max_level = MAX(hint_max_level, ?), hints_used = hints_used + 1, updated_at = ?
     WHERE id = ? AND learner_id = ? AND hint_max_level >= ?`,
  ).bind(level, nowIso(now), run.id, learner.id, level - 1).run();
  if ((unlocked.meta.changes ?? 0) === 0) throw new LearningError('forbidden', `Hãy xem gợi ý nấc ${level - 1} trước nhé.`);

  const hint = await generateHint(deps, { learnerId: learner.id, runId: run.id, mission, step, level, stepAnswers: run.answers[step.id] });
  try {
    await db.prepare(
      `INSERT INTO coach_messages (id, learner_id, run_id, step_id, channel, role, content, hint_level, model, created_at)
       VALUES (?, ?, ?, ?, 'hint', 'assistant', ?, ?, ?, ?)`,
    ).bind(newId('cm'), learner.id, run.id, step.id, hint.text, level, hint.model, nowIso(now)).run();
  } catch (err) {
    console.error('store hint message failed', err);
  }
  await recordEventSafe(db, {
    learnerId: learner.id, name: 'hint.requested', runId: run.id, missionId: mission.id, missionVersion: run.missionVersion, source: run.source,
    props: { stepId: step.id, level, origin: hint.origin },
  });
  return { level: hint.level, text: hint.text, origin: hint.origin };
}
