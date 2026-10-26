/**
 * Validates learner answers at the boundary: only field ids the step declares (stepFieldIds), the value
 * type each field expects, and hard size limits so one run can never grow without bound.
 */
import { stepFieldIds, verificationVerdicts, type Mission, type MissionStep } from '../content/schema';
import { LearningError, type Answers } from './types';

export const ANSWER_LIMITS = {
  textChars: 8000,
  listItems: 30,
  listItemChars: 500,
  /** Serialized size of all answers of one run. */
  totalBytes: 64_000,
} as const;

type StepAnswers = Answers[string];
type Value = StepAnswers[string];

const invalid = (msg: string): LearningError => new LearningError('invalid', msg);

function asText(v: unknown, field: string): string {
  if (typeof v !== 'string') throw invalid(`Trường "${field}" phải là chữ.`);
  if (v.length > ANSWER_LIMITS.textChars) throw invalid(`Trường "${field}" quá dài (tối đa ${ANSWER_LIMITS.textChars} ký tự).`);
  return v;
}

function asList(v: unknown, field: string): string | string[] {
  if (typeof v === 'string') return asText(v, field);
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw invalid(`Trường "${field}" phải là danh sách chữ.`);
  if (v.length > ANSWER_LIMITS.listItems) throw invalid(`Trường "${field}" có quá nhiều dòng (tối đa ${ANSWER_LIMITS.listItems}).`);
  if (v.some((x: string) => x.length > ANSWER_LIMITS.listItemChars)) throw invalid(`Một dòng trong "${field}" quá dài.`);
  return v as string[];
}

function asOptionChoice(v: unknown, field: string, optionIds: string[], multi: boolean): string | string[] {
  const list = Array.isArray(v) && multi ? v : [v];
  if (list.length === 0 || list.some((x) => typeof x !== 'string' || !optionIds.includes(x))) {
    throw invalid(`Lựa chọn cho "${field}" không hợp lệ.`);
  }
  return Array.isArray(v) ? (list as string[]) : (v as string);
}

function validateField(step: MissionStep, field: string, v: unknown): Value {
  switch (step.type) {
    case 'guided-input': {
      const def = step.fields.find((f) => f.id === field);
      return def?.kind === 'list' ? asList(v, field) : asText(v, field);
    }
    case 'verification':
      if (field === step.notes.id) return asText(v, field);
      return asOptionChoice(v, field, [...verificationVerdicts], false);
    case 'quiz': {
      const q = step.questions.find((x) => x.id === field);
      return asOptionChoice(v, field, q ? q.options.map((o) => o.id) : [], true);
    }
    case 'prediction':
      if (field === 'choice') return asOptionChoice(v, field, step.options.map((o) => o.id), false);
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw invalid('Độ tự tin phải từ 0 đến 100.');
      return Math.round(v);
    case 'ai-task':
    case 'reflection':
    case 'intro':
      return asText(v, field);
  }
}

/** Validates the answers of one step and returns a clean copy (unknown fields rejected). */
export function validateStepAnswers(step: MissionStep, raw: unknown): StepAnswers {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('Câu trả lời phải là một object.');
  const allowed = new Set(stepFieldIds(step));
  const out: StepAnswers = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!allowed.has(field)) throw invalid(`Bước "${step.id}" không có trường "${field}".`);
    if (value === null || value === undefined) continue;
    out[field] = validateField(step, field, value);
  }
  return out;
}

export function findStep(mission: Mission, stepId: string): MissionStep {
  const step = mission.steps.find((s) => s.id === stepId);
  if (!step) throw invalid(`Mission không có bước "${stepId}".`);
  return step;
}

/** Validates a whole answers document ({stepId: {field: value}}), e.g. answers passed with a submission. */
export function validateAnswersDoc(mission: Mission, raw: unknown): Answers {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw invalid('Câu trả lời phải là một object.');
  const out: Answers = {};
  for (const [stepId, stepAnswers] of Object.entries(raw)) out[stepId] = validateStepAnswers(findStep(mission, stepId), stepAnswers);
  assertAnswersSize(out);
  return out;
}

export function assertAnswersSize(answers: Answers): void {
  if (new TextEncoder().encode(JSON.stringify(answers)).length > ANSWER_LIMITS.totalBytes) {
    throw invalid('Bài làm quá dài. Hãy rút gọn bớt câu trả lời.');
  }
}

/** Merges new step answers into a run's answers (a step's answers are replaced as a whole). */
export function mergeAnswers(base: Answers, patch: Answers): Answers {
  const merged: Answers = { ...base };
  for (const [stepId, stepAnswers] of Object.entries(patch)) merged[stepId] = stepAnswers;
  return merged;
}
