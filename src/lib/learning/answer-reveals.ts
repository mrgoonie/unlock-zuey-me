/**
 * Answer keys and server-recorded reveals.
 *
 * A quiz question or a prediction can be revealed before submitting ("Kiểm tra" / "Chốt dự đoán"): the
 * reveal is stored on the run (mission_runs.revealed_json) and returns that one item's key. From then on
 * the revealed answer is locked: saveAnswers and submitEvidence reject any change to it. Verification
 * verdicts cannot be revealed early (they are graded); every key is visible once the run is completed.
 * Abandoning the run does not undo a reveal: the next run of the mission starts with it (carried-penalties.ts).
 */
import { getMission } from '../content/loader';
import type { Mission, MissionStep } from '../content/schema';
import { nowIso } from '../db/ids';
import { findRun } from '../db/run-repository';
import { findStep } from './answers-validation';
import { RevealedAnswerLockedError, RunConflictError, runNotFound } from './errors';
import { canEdit, effectiveStatus } from './mission-state-machine';
import { loadRun, type RunDeps } from './mission-runs';
import { PREDICTION_ITEM, PREDICTION_LOCKED_FIELDS, revealKey, splitRevealKey } from './reveal-keys';
import {
  LearningError, type AnswerKey, type AnswerKeyEntry, type Answers, type LearnerContext, type MissionRun,
} from './types';

/** The key of one revealable item, or null when the step/item has none (verification claims included). */
export function revealableEntry(step: MissionStep, itemId: string): AnswerKeyEntry | null {
  if (step.type === 'quiz') {
    const q = step.questions.find((x) => x.id === itemId);
    return q ? { correct: [...q.correct], explanation: q.explanation } : null;
  }
  if (step.type === 'prediction' && itemId === PREDICTION_ITEM) return { correct: [step.correct], explanation: step.explanation };
  return null;
}

/** Answer fields a reveal locks: the question's field (quiz) or the choice and its confidence (prediction). */
export function lockedFields(step: MissionStep, itemId: string): string[] {
  if (step.type === 'quiz') return [itemId];
  if (step.type === 'prediction') return [...PREDICTION_LOCKED_FIELDS];
  return [];
}

/** Every key of the mission (shown once the run is completed). */
function fullAnswerKey(mission: Mission): AnswerKey {
  const key: AnswerKey = {};
  for (const step of mission.steps) {
    if (step.type === 'verification') {
      for (const c of step.claims) key[revealKey(step.id, c.id)] = { correct: [c.answer], explanation: c.explanation };
    } else if (step.type === 'quiz') {
      for (const q of step.questions) key[revealKey(step.id, q.id)] = { correct: [...q.correct], explanation: q.explanation };
    } else if (step.type === 'prediction') {
      key[revealKey(step.id, PREDICTION_ITEM)] = { correct: [step.correct], explanation: step.explanation };
    }
  }
  return key;
}

/** What the learner may see of the key for this run: everything when completed, else only revealed items. */
export function answerKeyForRun(mission: Mission, run: Pick<MissionRun, 'status' | 'revealed'>): AnswerKey {
  if (run.status === 'completed') return fullAnswerKey(mission);
  const key: AnswerKey = {};
  for (const k of run.revealed) {
    const parts = splitRevealKey(k);
    const step = parts && mission.steps.find((s) => s.id === parts.stepId);
    const entry = step && parts ? revealableEntry(step, parts.itemId) : null;
    if (entry) key[k] = entry;
  }
  return key;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Throws RevealedAnswerLockedError (forbidden) when `next` changes an answer revealed (so locked) in `run`. */
export function assertRevealedUnchanged(mission: Mission, run: MissionRun, next: Answers): void {
  const before = run.answers;
  for (const k of run.revealed) {
    const parts = splitRevealKey(k);
    const step = parts && mission.steps.find((s) => s.id === parts.stepId);
    if (!step || !parts) continue;
    for (const field of lockedFields(step, parts.itemId)) {
      if (!same(before[step.id]?.[field], next[step.id]?.[field])) {
        throw new RevealedAnswerLockedError(run);
      }
    }
  }
}

/** True when the item's answer (the question's field, or the prediction choice) has a value. */
export function isAnswered(step: MissionStep, itemId: string, answers: Answers): boolean {
  const v = answers[step.id]?.[step.type === 'prediction' ? 'choice' : itemId];
  return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim() !== '';
}

/**
 * Reveals one quiz question or prediction: records it on the run (optimistic rev) and returns its key.
 * Revealing an item again is idempotent. The answer must already be saved, so it is locked as answered.
 */
export async function revealAnswerImpl(
  deps: RunDeps, learner: LearnerContext, runId: string, input: { stepId: string; itemId: string },
): Promise<{ run: MissionRun; key: AnswerKeyEntry }> {
  const run = await loadRun(deps, learner, runId);
  const mission = getMission(run.missionId);
  if (!mission) throw new LearningError('unavailable', 'Mission này tạm thời không khả dụng.');
  const step = findStep(mission, input.stepId);
  const entry = typeof input.itemId === 'string' ? revealableEntry(step, input.itemId) : null;
  if (!entry) throw new LearningError('invalid', 'Câu này không có đáp án để xem trước.');
  const k = revealKey(step.id, input.itemId);
  if (run.revealed.includes(k)) return { run, key: entry };
  if (!canEdit(run.status)) throw new LearningError('conflict', 'Bài làm này không còn chỉnh sửa được nữa.');
  if (!isAnswered(step, input.itemId, run.answers)) {
    throw new LearningError('invalid', 'Hãy chọn câu trả lời (và đợi lưu xong) rồi mới xem đáp án nhé.');
  }

  const now = deps.now?.() ?? new Date();
  const next: MissionRun = { ...run, revealed: [...run.revealed, k], rev: run.rev + 1, updatedAt: nowIso(now) };
  const res = await deps.env.DB.prepare(
    'UPDATE mission_runs SET revealed_json = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND learner_id = ? AND rev = ?',
  ).bind(JSON.stringify(next.revealed), next.updatedAt, run.id, learner.id, run.rev).run();
  if ((res.meta.changes ?? 0) === 0) {
    const current = await findRun(deps.env.DB, learner.id, run.id);
    if (!current) throw runNotFound();
    throw new RunConflictError({ ...current, status: effectiveStatus(current, now) });
  }
  return { run: next, key: entry };
}
