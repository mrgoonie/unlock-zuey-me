/** Activity days (learner-local dates) and the streak derived from them. */
import { activityDaysSince, insertActivityDay } from '../db/progress-queries';
import { addDays, localDay } from './learner-day';
import { computeStreak } from './streak';
import type { LearnerContext, StreakInfo } from './types';

const STREAK_WINDOW_DAYS = 400;

/** Marks today (learner timezone) as active. Never throws: a streak write must not fail a learning action. */
export async function recordActivityDay(db: D1Database, learner: LearnerContext, now: Date): Promise<void> {
  try {
    await insertActivityDay(db, learner.id, localDay(now, learner.profile.timezone));
  } catch (err) {
    console.error('recordActivityDay failed', err);
  }
}

export async function loadStreak(db: D1Database, learner: LearnerContext, now: Date): Promise<StreakInfo> {
  const today = localDay(now, learner.profile.timezone);
  const days = await activityDaysSince(db, learner.id, addDays(today, -STREAK_WINDOW_DAYS));
  return computeStreak(days, today);
}
