/** Learning errors that carry extra payload beyond LearningError's code + message. */
import { LearningError, type MissionRun } from './types';

/** Stale `rev` on an optimistic write: the API answers 409 with the current run so the client can rebase. */
export class RunConflictError extends LearningError {
  constructor(public run: MissionRun, message = 'Bài làm vừa được cập nhật ở nơi khác. Đã tải lại bản mới nhất.') {
    super('conflict', message);
  }
}

/**
 * Wire code of RevealedAnswerLockedError on /api/v1 (HTTP 403). It is distinct from the generic `forbidden`
 * so the browser runs its lock recovery (restoring the locked fields) only when the server really said so,
 * never for an unrelated 403 such as a WAF challenge or the origin check.
 */
export const ANSWER_LOCKED_CODE = 'answer_locked';

/**
 * A write would change an answer whose key was already revealed (locked). The API answers 403
 * `{ error: { code: 'answer_locked' }, run }` with the current run so the client can restore the locked
 * values and keep saving its other edits. The engine-level code stays `forbidden` (MCP tool errors use it).
 */
export class RevealedAnswerLockedError extends LearningError {
  readonly apiCode = ANSWER_LOCKED_CODE;

  constructor(public run: MissionRun, message = 'Bạn đã xem đáp án câu này nên không đổi câu trả lời được nữa.') {
    super('forbidden', message);
  }
}

export const runNotFound = (): LearningError => new LearningError('not_found', 'Không tìm thấy lượt làm bài này.');
export const missionNotFound = (): LearningError => new LearningError('not_found', 'Không tìm thấy mission này.');
