/** Pure helpers for the results screen (calibration copy, level-up detection, next mission pick). */
import type { MissionListItem, Rewards } from '../learning/types';

export interface Calibration { guessed: number; actual: number; message: string }

/** Compares the learner's self-assessment (0..100) with the real score (0..1). Null when no guess was made. */
export function calibration(confidence: number | null | undefined, score01: number): Calibration | null {
  if (confidence === null || confidence === undefined || Number.isNaN(confidence)) return null;
  const guessed = Math.round(Math.max(0, Math.min(100, confidence)));
  const actual = Math.round(Math.max(0, Math.min(1, score01)) * 100);
  const diff = guessed - actual;
  const message = Math.abs(diff) <= 10
    ? 'Bạn tự đánh giá rất sát. Đây là một kỹ năng quan trọng khi làm việc với AI!'
    : diff > 0
      ? 'Lần này bạn hơi tự tin hơn kết quả. Xem nhận xét bên dưới để biết chỗ cần chú ý.'
      : 'Bạn làm tốt hơn mình nghĩ đấy! Hãy tin vào bản thân hơn một chút.';
  return { guessed, actual, message };
}

/** True when this submission's XP crossed a level boundary. */
export const didLevelUp = (r: Pick<Rewards, 'xpGained' | 'level'> | null | undefined): boolean =>
  !!r && r.xpGained > 0 && r.level.xpIntoLevel < r.xpGained;

/** Next mission to suggest after finishing `currentId`: recommended first, then any not completed. */
export function pickNextMission(missions: MissionListItem[], currentId: string, exclude: string[] = []): MissionListItem | null {
  const open = missions.filter((m) => m.id !== currentId && !exclude.includes(m.id) && m.status !== 'completed');
  return open.find((m) => m.recommended) ?? open[0] ?? null;
}
