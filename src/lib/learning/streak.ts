/**
 * Soft streak: consecutive active days where a single missed day ("rest day") is forgiven, at most one rest
 * day in any rolling 7-day window (two rest days must be ≥ 7 days apart). Two missed days in a row end it.
 * Today never breaks a streak: if the learner has not been active yet today, counting starts from yesterday.
 * `current` counts active days only (rest days bridge but do not add).
 */
import { addDays, dayDiff } from './learner-day';
import type { StreakInfo } from './types';

const MAX_LOOKBACK_DAYS = 400;

export function computeStreak(activeDays: Iterable<string>, today: string): StreakInfo {
  const days = new Set(activeDays);
  const activeToday = days.has(today);
  let cursor = activeToday ? today : addDays(today, -1);
  let current = 0;
  // Rest days used by the current streak, newest first.
  const rests: string[] = [];

  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
    if (days.has(cursor)) {
      current++;
    } else {
      // A rest day must sit between two active days of the streak and be ≥ 7 days from the next-newer rest day.
      const bridges = days.has(addDays(cursor, -1)) && (current > 0 || !activeToday);
      const newerRest = rests[rests.length - 1];
      const tooClose = newerRest !== undefined && dayDiff(newerRest, cursor) < 7;
      if (!bridges || tooClose) break;
      rests.push(cursor);
    }
    cursor = addDays(cursor, -1);
  }

  if (current === 0) return { current: 0, restDaysLeft: 1, activeToday };
  // A rest day is available for the next missed day (today if not active yet, otherwise tomorrow).
  const nextPossibleRest = activeToday ? addDays(today, 1) : today;
  const restDaysLeft = rests.length > 0 && dayDiff(nextPossibleRest, rests[0]) < 7 ? 0 : 1;
  return { current, restDaysLeft, activeToday };
}
