/** Props shared by every step renderer. `S` narrows the step to one variant of the learner-safe view. */
import type { LearnerStep, LearnerStepOf } from '../../../lib/learning/learner-mission-view';
import type { AnswerKey, Answers } from '../../../lib/learning/types';
import type { AnswerValue, RunDraft } from '../../../lib/ui/run-draft';

export type StepOf<T extends LearnerStep['type']> = LearnerStepOf<T>;

export interface StepProps<S extends LearnerStep = LearnerStep> {
  step: S;
  /** Answers of this step only. */
  values: Answers[string];
  onField: (fieldId: string, value: AnswerValue) => void;
  runId: string;
  draft: RunDraft;
  patchDraft: (fn: (d: RunDraft) => RunDraft) => void;
  /** Items revealed on the server ("stepId:itemId"); their answers are locked. */
  revealed: string[];
  /** Keys of revealed items, from the server. */
  answerKey: AnswerKey;
  /** Saves pending edits, then reveals one item on the server. Resolves to an error message, or null. */
  onReveal: (stepId: string, itemId: string) => Promise<string | null>;
}

export const str = (v: AnswerValue | undefined): string => (typeof v === 'string' ? v : '');
export const strList = (v: AnswerValue | undefined): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split('\n') : [];
