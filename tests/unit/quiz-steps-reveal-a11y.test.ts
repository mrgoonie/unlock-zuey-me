/**
 * The revealed quiz/prediction result is announced by moving focus to it, not by a live region: being both
 * focused and live made some screen readers read it twice.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PredictionStep, QuizStep } from '../../src/components/mission/steps/QuizSteps';
import type { StepProps } from '../../src/components/mission/steps/step-props';
import { listPublishedMissions } from '../../src/lib/content/loader';
import { learnerStep, type LearnerStep } from '../../src/lib/learning/learner-mission-view';
import type { AnswerKey } from '../../src/lib/learning/types';

const firstStep = <T extends 'quiz' | 'prediction'>(type: T) => {
  for (const m of listPublishedMissions()) {
    const s = m.steps.find((x) => x.type === type);
    if (s) return learnerStep(s) as Extract<LearnerStep, { type: T }>;
  }
  throw new Error(`no published ${type} step`);
};

const baseProps = (revealed: string[], answerKey: AnswerKey) => ({
  values: {}, onField: vi.fn(), runId: 'run_1', draft: {} as StepProps['draft'], patchDraft: vi.fn(),
  revealed, answerKey, onReveal: vi.fn(async () => null),
});

/** The opening tag of the revealed result box (the only focusable non-control element). */
const resultTag = (html: string): string => {
  const tag = html.match(/<div[^>]*tabindex="-1"[^>]*>/)?.[0];
  if (!tag) throw new Error('reveal result not rendered');
  return tag;
};

describe('revealed result accessibility', () => {
  it('quiz result is focusable but not a live region', () => {
    const step = firstStep('quiz');
    const key = `${step.id}:${step.questions[0].id}`;
    const html = renderToStaticMarkup(createElement(QuizStep, {
      step, ...baseProps([key], { [key]: { correct: [step.questions[0].options[0].id], explanation: 'Giải thích' } }),
    }));
    const tag = resultTag(html);
    expect(tag).not.toMatch(/aria-live|role="status"/);
    expect(html).toContain('Giải thích');
  });

  it('prediction result is focusable but not a live region', () => {
    const step = firstStep('prediction');
    const key = `${step.id}:prediction`;
    const html = renderToStaticMarkup(createElement(PredictionStep, {
      step, ...baseProps([key], { [key]: { correct: [step.options[0].id], explanation: 'Giải thích' } }),
    }));
    expect(resultTag(html)).not.toMatch(/aria-live|role="status"/);
  });
});
