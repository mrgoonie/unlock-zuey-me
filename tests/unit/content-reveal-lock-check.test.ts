/**
 * Content gate: a mission must stay passable when every revealable quiz/prediction item was revealed with
 * a wrong answer (those answers are locked on the run).
 */
import { describe, expect, it } from 'vitest';
import { listPublishedMissions } from '../../src/lib/content/loader';
import type { Mission, RubricCriterion } from '../../src/lib/content/schema';
import { bestScoreWithWrongReveals, revealLockErrors } from '../../scripts/validate-content';

const hints = ['a', 'b', 'c', 'd'] as [string, string, string, string];

function mission(passScore: number, weights: { quiz: number; prediction: number; text: number; ai: number }): Mission {
  const base = listPublishedMissions()[0];
  return {
    ...base,
    id: 'locked-heavy',
    steps: [
      { id: 'q', type: 'quiz', title: 'Q', hints, questions: [{ id: 'q1', prompt: 'P', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['a'], explanation: 'E' }] },
      { id: 'p', type: 'prediction', title: 'P', hints, question: 'Q', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: 'a', explanation: 'E' },
      { id: 'r', type: 'reflection', title: 'R', hints, prompt: 'P', field_id: 'lesson', min: 30 },
    ],
    rubric: {
      pass_score: passScore,
      criteria: ([
        { id: 'quiz', label: 'Q', weight: weights.quiz, competency: 'verify', method: 'deterministic', check: { kind: 'quiz_score', step: 'q' }, step_refs: [] },
        { id: 'pred', label: 'P', weight: weights.prediction, competency: 'verify', method: 'deterministic', check: { kind: 'prediction_correct', step: 'p' }, step_refs: [] },
        { id: 'text', label: 'T', weight: weights.text, competency: 'reflect', method: 'deterministic', check: { kind: 'text_min', step: 'r', field: 'lesson', min_chars: 30 }, step_refs: [] },
        // AI criteria reading a quiz step are still improvable (the grader reads the whole answer), so they count as free.
        { id: 'ai', label: 'A', weight: weights.ai, competency: 'reflect', method: 'ai', guidance: 'G', step_refs: ['q', 'r'] },
      ] satisfies RubricCriterion[]).filter((c) => c.weight > 0),
    },
  };
}

describe('reveal-lock content check', () => {
  it('computes the best weighted score with every revealable item wrong', () => {
    expect(bestScoreWithWrongReveals(mission(0.7, { quiz: 2, prediction: 1, text: 3, ai: 4 }))).toBeCloseTo(0.7);
    expect(bestScoreWithWrongReveals(mission(0.7, { quiz: 0, prediction: 0, text: 1, ai: 1 }))).toBe(1);
  });

  it('fails a mission whose revealable weight makes passing impossible', () => {
    const errors = revealLockErrors([mission(0.7, { quiz: 3, prediction: 1, text: 3, ai: 3 })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/mission locked-heavy: .*best score is 0\.6 < pass_score 0\.7/);
  });

  it('accepts the exact boundary (decideStatus passes score >= pass_score)', () => {
    expect(revealLockErrors([mission(0.7, { quiz: 2, prediction: 1, text: 3, ai: 4 })])).toEqual([]);
  });

  it('accepts every shipped mission', () => {
    const missions = listPublishedMissions();
    expect(missions.length).toBeGreaterThan(0);
    expect(revealLockErrors(missions)).toEqual([]);
  });
});
