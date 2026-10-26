import { describe, expect, it } from 'vitest';
import { addDays, localDay } from '../../src/lib/learning/learner-day';
import { effectiveStatus, STALE_EVALUATING_MS, transition } from '../../src/lib/learning/mission-state-machine';
import { computeStreak } from '../../src/lib/learning/streak';
import { LearningError } from '../../src/lib/learning/types';

describe('mission state machine', () => {
  it('follows the happy path', () => {
    expect(transition('started', { type: 'edit', reachedLastStep: false })).toBe('started');
    expect(transition('started', { type: 'edit', reachedLastStep: true })).toBe('awaiting_evidence');
    expect(transition('awaiting_evidence', { type: 'submit' })).toBe('evaluating');
    expect(transition('evaluating', { type: 'graded', passed: true })).toBe('completed');
    expect(transition('evaluating', { type: 'graded', passed: false })).toBe('needs_revision');
    expect(transition('evaluating', { type: 'grading_failed' })).toBe('evaluation_failed');
  });
  it('keeps needs_revision on edit and reopens evaluation_failed', () => {
    expect(transition('needs_revision', { type: 'edit', reachedLastStep: false })).toBe('needs_revision');
    expect(transition('evaluation_failed', { type: 'edit', reachedLastStep: false })).toBe('started');
    expect(transition('evaluation_failed', { type: 'submit' })).toBe('evaluating');
    expect(transition('paused', { type: 'edit', reachedLastStep: false })).toBe('started');
  });
  it('rejects illegal moves with conflict', () => {
    for (const [from, ev] of [
      ['completed', { type: 'edit', reachedLastStep: false }], ['completed', { type: 'submit' }],
      ['evaluating', { type: 'submit' }], ['evaluating', { type: 'edit', reachedLastStep: false }],
      ['started', { type: 'graded', passed: true }], ['abandoned', { type: 'abandon' }],
    ] as const) {
      expect(() => transition(from, ev)).toThrow(LearningError);
    }
  });
  it('treats a stale evaluation as failed', () => {
    const now = new Date('2026-10-26T10:00:00Z');
    expect(effectiveStatus({ status: 'evaluating', updatedAt: new Date(now.getTime() - 1000).toISOString() }, now)).toBe('evaluating');
    expect(effectiveStatus({ status: 'evaluating', updatedAt: new Date(now.getTime() - STALE_EVALUATING_MS - 1).toISOString() }, now)).toBe('evaluation_failed');
  });
});

describe('learner days', () => {
  it('uses the learner timezone (default Asia/Saigon)', () => {
    const d = new Date('2026-10-26T18:30:00Z'); // 01:30 on the 27th in Saigon
    expect(localDay(d)).toBe('2026-10-27');
    expect(localDay(d, 'UTC')).toBe('2026-10-26');
    expect(localDay(d, 'Not/AZone')).toBe('2026-10-27');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('soft streak', () => {
  const today = '2026-10-26';
  const days = (...offsets: number[]) => offsets.map((o) => addDays(today, -o));

  it('counts consecutive days including today', () => {
    expect(computeStreak(days(0, 1, 2), today)).toEqual({ current: 3, restDaysLeft: 1, activeToday: true });
  });
  it('does not break before today is over', () => {
    expect(computeStreak(days(1, 2), today)).toEqual({ current: 2, restDaysLeft: 1, activeToday: false });
  });
  it('forgives one rest day and reports it as used', () => {
    expect(computeStreak(days(0, 2, 3), today)).toEqual({ current: 3, restDaysLeft: 0, activeToday: true });
  });
  it('yesterday as rest day keeps the streak alive but no rest is left today', () => {
    expect(computeStreak(days(2, 3), today)).toEqual({ current: 2, restDaysLeft: 0, activeToday: false });
  });
  it('two missed days in a row end the streak', () => {
    expect(computeStreak(days(0, 3, 4), today).current).toBe(1);
    expect(computeStreak(days(3, 4), today).current).toBe(0);
  });
  it('allows at most one rest day per rolling 7 days', () => {
    // rests at offsets 1 and 4 (3 days apart) → only the newer one is forgiven
    expect(computeStreak(days(0, 2, 3, 5, 6), today).current).toBe(3);
    // rests at offsets 1 and 8 (7 days apart) → both forgiven
    expect(computeStreak(days(0, 2, 3, 4, 5, 6, 7, 9), today).current).toBe(8);
  });
  it('rest day becomes available again after 7 days', () => {
    expect(computeStreak(days(0, 1, 2, 3, 4, 5, 7), today).restDaysLeft).toBe(1);
    expect(computeStreak(days(0, 1, 2, 3, 4, 6), today).restDaysLeft).toBe(0);
  });
  it('no activity → empty streak', () => {
    expect(computeStreak([], today)).toEqual({ current: 0, restDaysLeft: 1, activeToday: false });
  });
});
