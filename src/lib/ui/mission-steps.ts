/**
 * Pure helpers about mission steps used by the runner: is a step filled enough to continue, which step a
 * rubric criterion points to (to jump back on needs_revision), and list-field parsing.
 */
import type { Mission, MissionStep } from '../content/schema';
import type { Answers } from '../learning/types';

/** List fields are edited as one item per line; empty lines are dropped. */
export const listItems = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean)
    : typeof v === 'string' ? v.split('\n').map((s) => s.trim()).filter(Boolean) : [];

const textLen = (v: unknown): number => (typeof v === 'string' ? v.trim().length : 0);

export interface StepGap { fieldId: string; message: string }

/**
 * Lists what is still missing for a step (empty = complete). Messages are shown to the learner, so they are
 * friendly and concrete ("cần thêm 2 dòng"), never blocking: the learner may still move on.
 */
export function stepGaps(step: MissionStep, answers: Answers): StepGap[] {
  const a = answers[step.id] ?? {};
  const gaps: StepGap[] = [];
  const needText = (fieldId: string, min: number, label: string) => {
    const n = textLen(a[fieldId]);
    if (n < Math.max(1, min)) gaps.push({ fieldId, message: n === 0 ? `Chưa điền: ${label}` : `${label}: cần thêm ${Math.max(1, min) - n} ký tự` });
  };
  switch (step.type) {
    case 'intro':
      break;
    case 'guided-input':
      for (const f of step.fields) {
        if (!f.required) continue;
        if (f.kind === 'list') {
          const n = listItems(a[f.id]).length;
          if (n < Math.max(1, f.min)) gaps.push({ fieldId: f.id, message: `${f.label}: cần thêm ${Math.max(1, f.min) - n} dòng` });
        } else needText(f.id, f.min, f.label);
      }
      break;
    case 'ai-task':
      needText(step.capture.id, step.capture.min, step.capture.label);
      break;
    case 'verification':
      for (const c of step.claims) if (!a[c.id]) gaps.push({ fieldId: c.id, message: `Chưa chọn mức tin cậy cho: “${c.text}”` });
      needText(step.notes.id, step.notes.min, step.notes.label);
      break;
    case 'quiz':
      for (const q of step.questions) {
        const v = a[q.id];
        if (!v || (Array.isArray(v) && v.length === 0)) gaps.push({ fieldId: q.id, message: `Chưa trả lời: ${q.prompt}` });
      }
      break;
    case 'prediction':
      if (!a.choice) gaps.push({ fieldId: 'choice', message: 'Chưa chọn dự đoán' });
      break;
    case 'reflection':
      needText(step.field_id, step.min, 'Phần đúc kết');
      break;
  }
  return gaps;
}

export const isStepComplete = (step: MissionStep, answers: Answers): boolean => stepGaps(step, answers).length === 0;

/** Index of the step a rubric criterion is about (its check step, else its first step ref), or -1. */
export function criterionStepIndex(mission: Mission, criterionId: string): number {
  const c = mission.rubric.criteria.find((x) => x.id === criterionId);
  if (!c) return -1;
  const stepId = c.check?.step ?? c.step_refs[c.step_refs.length - 1] ?? c.step_refs[0];
  return stepId ? mission.steps.findIndex((s) => s.id === stepId) : -1;
}

/** Vietnamese label per step type (shown above the step title). */
export const STEP_KIND_LABEL: Record<MissionStep['type'], string> = {
  intro: 'Giới thiệu',
  'guided-input': 'Ghi ra ý của bạn',
  'ai-task': 'Làm cùng AI',
  verification: 'Kiểm chứng',
  quiz: 'Câu hỏi nhanh',
  prediction: 'Dự đoán',
  reflection: 'Đúc kết',
};
