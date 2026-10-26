/** Learning errors that carry extra payload beyond LearningError's code + message. */
import { LearningError, type MissionRun } from './types';

/** Stale `rev` on an optimistic write: the API answers 409 with the current run so the client can rebase. */
export class RunConflictError extends LearningError {
  constructor(public run: MissionRun, message = 'Bài làm vừa được cập nhật ở nơi khác. Đã tải lại bản mới nhất.') {
    super('conflict', message);
  }
}

export const runNotFound = (): LearningError => new LearningError('not_found', 'Không tìm thấy lượt làm bài này.');
export const missionNotFound = (): LearningError => new LearningError('not_found', 'Không tìm thấy mission này.');
