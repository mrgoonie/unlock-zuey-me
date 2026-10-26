/** Lab results (never XP; can unlock labs_completed badges) and concept page views. */
import { getConcept } from '../content/loader';
import { newId, nowIso } from '../db/ids';
import { labsDone } from '../db/progress-queries';
import { recordEventSafe } from '../observer/events';
import { loadStreak, recordActivityDay } from './activity';
import { grantEligibleBadges } from './badges';
import type { RunDeps } from './mission-runs';
import { LearningError, type LearnerContext, type Rewards } from './types';

export const LAB_IDS = ['token-predictor', 'context-lab', 'hallucination-detective'] as const;
export type LabId = (typeof LAB_IDS)[number];
const MAX_RESULT_BYTES = 4000;

export const isLabId = (id: string): id is LabId => (LAB_IDS as readonly string[]).includes(id);

export async function recordLabResult(
  deps: RunDeps, learner: LearnerContext, labId: string, result: unknown,
): Promise<{ labsDone: string[]; newBadges: Rewards['newBadges'] }> {
  if (!isLabId(labId)) throw new LearningError('not_found', 'Không tìm thấy bài thực hành này.');
  if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new LearningError('invalid', 'Kết quả phải là một object.');
  const json = JSON.stringify(result);
  if (new TextEncoder().encode(json).length > MAX_RESULT_BYTES) throw new LearningError('invalid', 'Kết quả quá lớn.');
  const db = deps.env.DB;
  const now = deps.now?.() ?? new Date();

  await db.prepare('INSERT INTO lab_runs (id, learner_id, lab_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(newId('lab'), learner.id, labId, json, nowIso(now)).run();
  const r = result as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // Lab UI posts {score, total, calibration?}; only these scalars go into the event.
  await recordEventSafe(db, {
    learnerId: learner.id, name: 'lab.completed', props: { labId, score: num(r.score), total: num(r.total), calibration: num(r.calibration) },
  });
  await recordActivityDay(db, learner, now);

  const streak = await loadStreak(db, learner, now);
  const newBadges = await grantEligibleBadges(deps.env, learner, { streakDays: streak.current, ref: `lab:${labId}`, source: 'web', now });
  return { labsDone: await labsDone(db, learner.id), newBadges };
}

export async function recordConceptView(deps: RunDeps, learner: LearnerContext, conceptId: string): Promise<void> {
  if (!getConcept(conceptId)) throw new LearningError('not_found', 'Không tìm thấy khái niệm này.');
  const now = deps.now?.() ?? new Date();
  const r = await deps.env.DB.prepare('INSERT OR IGNORE INTO concept_views (learner_id, concept_id, first_seen_at) VALUES (?, ?, ?)')
    .bind(learner.id, conceptId, nowIso(now)).run();
  if ((r.meta.changes ?? 0) > 0) await recordEventSafe(deps.env.DB, { learnerId: learner.id, name: 'concept.viewed', props: { conceptId } });
}
