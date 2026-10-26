/**
 * Hint requests: ladder order enforced on the run, one charge per (run, step, level), coach answer stored.
 *
 * The first request for a level reserves a run_hints row and charges hints_used in one atomic batch, then
 * asks the coach and stores the text on that row. A retry of an already-unlocked level (e.g. the browser
 * gave up while the coach was slow) returns the stored text: no new AI call and no second charge. While the
 * first request is still generating, a retry gets the authored static hint for that level.
 */
import { getMission } from '../content/loader';
import type { MissionStep } from '../content/schema';
import type { AiDeps } from '../coach/ai-gateway';
import { generateHint } from '../coach/hint-coach';
import { newId, nowIso } from '../db/ids';
import { recordEventSafe } from '../observer/events';
import { findStep } from './answers-validation';
import { isOpen } from './mission-state-machine';
import { loadRun } from './mission-runs';
import { LearningError, type HintResult, type LearnerContext } from './types';

type Level = HintResult['level'];

interface StoredHint { text: string | null; origin: HintResult['origin'] | null }

const staticHint = (step: MissionStep, level: Level): HintResult => ({ level, text: step.hints[level - 1], origin: 'static' });

async function findStoredHint(db: D1Database, runId: string, stepId: string, level: Level): Promise<StoredHint | null> {
  return db.prepare('SELECT text, origin FROM run_hints WHERE run_id = ? AND step_id = ? AND level = ?')
    .bind(runId, stepId, level).first<StoredHint>();
}

/** Stored text once generated, else the static hint (the first request is still generating). */
const fromStored = (stored: StoredHint, step: MissionStep, level: Level): HintResult =>
  stored.text ? { level, text: stored.text, origin: stored.origin ?? 'static' } : staticHint(step, level);

export async function requestHintImpl(
  deps: AiDeps, learner: LearnerContext, runId: string, stepId: string, level: Level,
): Promise<HintResult> {
  if (![1, 2, 3, 4].includes(level)) throw new LearningError('invalid', 'Nấc gợi ý phải từ 1 đến 4.');
  const run = await loadRun(deps, learner, runId);
  if (!isOpen(run.status)) throw new LearningError('conflict', 'Mission này đã kết thúc, không cần gợi ý nữa.');
  const mission = getMission(run.missionId);
  if (!mission) throw new LearningError('unavailable', 'Mission này tạm thời không khả dụng.');
  const step = findStep(mission, stepId);
  const db = deps.env.DB;
  const now = deps.now?.() ?? new Date();

  const existing = await findStoredHint(db, run.id, step.id, level);
  if (existing) return fromStored(existing, step, level);

  // Reserve the level (only while the ladder allows it: level n after level n-1) and charge it atomically.
  // The charge is guarded on this reservation's id, so a concurrent duplicate request charges nothing.
  const hintId = newId('rh');
  const [reserved] = await db.batch([
    db.prepare(
      `INSERT INTO run_hints (id, run_id, step_id, level, created_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM mission_runs WHERE id = ? AND learner_id = ? AND hint_max_level >= ?)
       ON CONFLICT (run_id, step_id, level) DO NOTHING`,
    ).bind(hintId, run.id, step.id, level, nowIso(now), run.id, learner.id, level - 1),
    db.prepare(
      `UPDATE mission_runs SET hint_max_level = MAX(hint_max_level, ?), hints_used = hints_used + 1, updated_at = ?
       WHERE id = ? AND learner_id = ? AND EXISTS (SELECT 1 FROM run_hints WHERE id = ?)`,
    ).bind(level, nowIso(now), run.id, learner.id, hintId),
  ]);
  if ((reserved?.meta.changes ?? 0) === 0) {
    const raced = await findStoredHint(db, run.id, step.id, level);
    if (raced) return fromStored(raced, step, level);
    throw new LearningError('forbidden', `Hãy xem gợi ý nấc ${level - 1} trước nhé.`);
  }

  let hint: HintResult & { model: string | null };
  try {
    hint = await generateHint(deps, { learnerId: learner.id, runId: run.id, mission, step, level, stepAnswers: run.answers[step.id] });
  } catch (err) {
    // generateHint already falls back on AI errors; this covers anything unexpected (e.g. a KV failure).
    console.error('hint generation failed, serving the static hint', err);
    hint = { ...staticHint(step, level), model: null };
  }
  try {
    await db.batch([
      db.prepare('UPDATE run_hints SET text = ?, origin = ?, model = ? WHERE id = ?').bind(hint.text, hint.origin, hint.model, hintId),
      db.prepare(
        `INSERT INTO coach_messages (id, learner_id, run_id, step_id, channel, role, content, hint_level, model, created_at)
         VALUES (?, ?, ?, ?, 'hint', 'assistant', ?, ?, ?, ?)`,
      ).bind(newId('cm'), learner.id, run.id, step.id, hint.text, level, hint.model, nowIso(now)),
    ]);
  } catch (err) {
    // The learner still gets this hint; a retry would then see the reservation and serve the static text.
    console.error('store hint failed', err);
  }
  await recordEventSafe(db, {
    learnerId: learner.id, name: 'hint.requested', runId: run.id, missionId: mission.id, missionVersion: run.missionVersion, source: run.source,
    props: { stepId: step.id, level, origin: hint.origin },
  });
  return { level: hint.level, text: hint.text, origin: hint.origin };
}
