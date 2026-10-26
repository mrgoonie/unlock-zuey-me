import { describe, expect, it } from 'vitest';
import { competencyAverages, decideStatus, emaUpdate, weightedScore } from '../../src/lib/learning/scoring';
import { computeMissionXp, isCalibrated, levelForXp, LEVELS } from '../../src/lib/learning/xp-and-levels';
import type { CriterionResult } from '../../src/lib/learning/types';

const crit = (competency: CriterionResult['competency'], weight: number, score: number): CriterionResult =>
  ({ id: `${competency}-${weight}`, label: 'x', weight, score, method: 'deterministic', competency, feedback: '' });

describe('weightedScore / decideStatus', () => {
  it('weights scores and clamps out-of-range values', () => {
    expect(weightedScore([{ weight: 3, score: 1 }, { weight: 1, score: 0 }])).toBe(0.75);
    expect(weightedScore([{ weight: 1, score: 5 }, { weight: 1, score: -2 }])).toBe(0.5);
    expect(weightedScore([{ weight: 1, score: Number.NaN }])).toBe(0);
    expect(weightedScore([])).toBe(0);
  });
  it('passes at exactly pass_score', () => {
    expect(decideStatus(0.7, 0.7)).toBe('passed');
    expect(decideStatus(0.699, 0.7)).toBe('needs_revision');
  });
});

describe('competency EMA', () => {
  it('first evidence sets the score, then moves by alpha', () => {
    const first = emaUpdate({ score: 0, evidenceCount: 0 }, 0.8);
    expect(first).toEqual({ score: 0.8, evidenceCount: 1 });
    const second = emaUpdate(first, 0.4);
    expect(second.score).toBeCloseTo(0.6, 3);
    const many = emaUpdate({ score: 0.5, evidenceCount: 10 }, 1);
    expect(many.score).toBeCloseTo(0.65, 3);
  });
  it('averages criteria per competency by weight', () => {
    const avg = competencyAverages([crit('verify', 1, 1), crit('verify', 3, 0), crit('describe', 2, 0.5)]);
    expect(avg.get('verify')).toBeCloseTo(0.25);
    expect(avg.get('describe')).toBeCloseTo(0.5);
  });
});

describe('XP and levels', () => {
  it('base XP from estimated minutes plus bonuses', () => {
    expect(computeMissionXp({ estimatedMinutes: 15, hintsUsed: 2, confidence: null, score: 0.8 })).toEqual({ base: 150, noHintBonus: 0, calibrationBonus: 0, total: 150 });
    expect(computeMissionXp({ estimatedMinutes: 15, hintsUsed: 0, confidence: 80, score: 0.9 }).total).toBe(210);
    expect(computeMissionXp({ estimatedMinutes: 15, hintsUsed: 0, confidence: 50, score: 0.9 }).calibrationBonus).toBe(0);
  });
  it('calibration tolerance is inclusive', () => {
    expect(isCalibrated(85, 0.7)).toBe(true);
    expect(isCalibrated(86, 0.7)).toBe(false);
    expect(isCalibrated(null, 0.7)).toBe(false);
  });
  it('levels by threshold', () => {
    expect(levelForXp(0)).toEqual({ id: 'L0', name: 'Explorer', xpIntoLevel: 0, xpForNext: 300 });
    expect(levelForXp(299).id).toBe('L0');
    expect(levelForXp(300)).toMatchObject({ id: 'L1', xpIntoLevel: 0, xpForNext: 900 });
    expect(levelForXp(5000)).toMatchObject({ id: 'L3', xpIntoLevel: 5000 - LEVELS[3].minXp, xpForNext: null });
    expect(levelForXp(-5).id).toBe('L0');
  });
});
