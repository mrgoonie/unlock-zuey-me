/**
 * Mission run state machine. All status changes go through `transition`, so an illegal move (editing a
 * completed run, submitting while another evaluation is running) is rejected in one place.
 *
 *   started ⇄ paused, started → awaiting_evidence (learner reached the last step)
 *   started | paused | awaiting_evidence | needs_revision | evaluation_failed --submit--> evaluating
 *   evaluating --graded--> completed | needs_revision ; evaluating --grading_failed--> evaluation_failed
 *   any open status --abandon--> abandoned ; completed and abandoned are terminal.
 * Editing a needs_revision run keeps it needs_revision; editing an evaluation_failed run moves it back to
 * started (the next submit then freezes the edited answers instead of retrying the stored submission).
 */
import { LearningError, type MissionRun, type RunStatus } from './types';

export type RunEvent =
  | { type: 'edit'; reachedLastStep: boolean }
  | { type: 'pause' }
  | { type: 'submit' }
  | { type: 'graded'; passed: boolean }
  | { type: 'grading_failed' }
  | { type: 'abandon' };

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'abandoned'];
const EDITABLE: readonly RunStatus[] = ['started', 'paused', 'awaiting_evidence', 'needs_revision', 'evaluation_failed'];

/** An `evaluating` run older than this is treated as a crashed evaluation that the learner may retry. */
export const STALE_EVALUATING_MS = 3 * 60_000;

export const isOpen = (s: RunStatus): boolean => !TERMINAL_STATUSES.includes(s);
export const canEdit = (s: RunStatus): boolean => EDITABLE.includes(s);
export const canSubmit = (s: RunStatus): boolean => EDITABLE.includes(s);

const illegal = (from: RunStatus, ev: RunEvent): LearningError => {
  if (from === 'completed') return new LearningError('conflict', 'Mission này đã hoàn thành.');
  if (from === 'abandoned') return new LearningError('conflict', 'Lượt làm bài này đã dừng. Hãy bắt đầu lượt mới.');
  if (from === 'evaluating') return new LearningError('conflict', 'Bài làm đang được chấm. Vui lòng đợi một chút.');
  return new LearningError('conflict', `Không thể thực hiện "${ev.type}" khi bài làm đang ở trạng thái "${from}".`);
};

export function transition(from: RunStatus, ev: RunEvent): RunStatus {
  switch (ev.type) {
    case 'edit':
      if (!canEdit(from)) throw illegal(from, ev);
      if (from === 'needs_revision') return 'needs_revision';
      return ev.reachedLastStep ? 'awaiting_evidence' : 'started';
    case 'pause':
      if (from !== 'started' && from !== 'awaiting_evidence') throw illegal(from, ev);
      return 'paused';
    case 'submit':
      if (!canSubmit(from)) throw illegal(from, ev);
      return 'evaluating';
    case 'graded':
      if (from !== 'evaluating') throw illegal(from, ev);
      return ev.passed ? 'completed' : 'needs_revision';
    case 'grading_failed':
      if (from !== 'evaluating') throw illegal(from, ev);
      return 'evaluation_failed';
    case 'abandon':
      if (!isOpen(from)) throw illegal(from, ev);
      return 'abandoned';
  }
}

/** Status as the learner should see it: an evaluation that crashed mid-way counts as evaluation_failed. */
export function effectiveStatus(run: Pick<MissionRun, 'status' | 'updatedAt'>, now: Date): RunStatus {
  if (run.status === 'evaluating' && now.getTime() - Date.parse(run.updatedAt) > STALE_EVALUATING_MS) return 'evaluation_failed';
  return run.status;
}
