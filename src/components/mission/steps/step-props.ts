/** Props shared by every step renderer. `S` narrows the step to one schema variant. */
import type { MissionStep } from '../../../lib/content/schema';
import type { Answers } from '../../../lib/learning/types';
import type { AnswerValue, RunDraft } from '../../../lib/ui/run-draft';

export type StepOf<T extends MissionStep['type']> = Extract<MissionStep, { type: T }>;

export interface StepProps<S extends MissionStep = MissionStep> {
  step: S;
  /** Answers of this step only. */
  values: Answers[string];
  onField: (fieldId: string, value: AnswerValue) => void;
  runId: string;
  draft: RunDraft;
  patchDraft: (fn: (d: RunDraft) => RunDraft) => void;
}

export const str = (v: AnswerValue | undefined): string => (typeof v === 'string' ? v : '');
export const strList = (v: AnswerValue | undefined): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split('\n') : [];
