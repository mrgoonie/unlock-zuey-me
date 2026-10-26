/** Renders a mission step and the learner's answers to it as prompt text (labels from content, values fenced). */
import type { MissionStep } from '../content/schema';
import type { Answers } from '../learning/types';
import { fenceUntrusted } from './untrusted-text';

/** Placeholder the grader sees instead of screenshots: images are never sent to models. */
export const IMAGE_PLACEHOLDER = '[ảnh chụp màn hình đính kèm]';

/** What the step asks the learner to do (authored content, trusted). */
export function stepInstruction(step: MissionStep): string {
  switch (step.type) {
    case 'intro': return step.body;
    case 'guided-input': return step.prompt;
    case 'ai-task': return step.instruction;
    case 'verification': return step.instruction;
    case 'quiz': return step.questions.map((q) => q.prompt).join(' / ');
    case 'prediction': return step.question;
    case 'reflection': return step.prompt;
  }
}

export function fieldLabel(step: MissionStep, fieldId: string): string {
  switch (step.type) {
    case 'guided-input': return step.fields.find((f) => f.id === fieldId)?.label ?? fieldId;
    case 'ai-task': return step.capture.label;
    case 'verification':
      if (fieldId === step.notes.id) return step.notes.label;
      return `Nhận định "${step.claims.find((c) => c.id === fieldId)?.text ?? fieldId}" — người học đánh giá`;
    case 'quiz': return step.questions.find((q) => q.id === fieldId)?.prompt ?? fieldId;
    case 'prediction': return fieldId === 'choice' ? 'Lựa chọn dự đoán' : 'Độ tự tin (0-100)';
    case 'reflection': return 'Đúc kết';
    case 'intro': return fieldId;
  }
}

const valueText = (v: Answers[string][string]): string =>
  Array.isArray(v) ? v.map((x) => `- ${x}`).join('\n') : String(v);

/** The learner's answers to one step as "label: value" lines, fenced as untrusted data. */
export function renderStepAnswers(step: MissionStep, answers: Answers[string] | undefined, boundary: string): string {
  const lines: string[] = [];
  for (const [field, v] of Object.entries(answers ?? {})) lines.push(`${fieldLabel(step, field)}:\n${valueText(v)}`);
  return fenceUntrusted(lines.length ? lines.join('\n\n') : '(trống)', boundary);
}

/** One placeholder line per attached screenshot. */
export function imagePlaceholders(imageCount: number): string {
  if (imageCount <= 0) return '';
  return `${Array.from({ length: imageCount }, () => IMAGE_PLACEHOLDER).join('\n')}\n(Screenshots are not shown to you; do not assume their content.)`;
}
