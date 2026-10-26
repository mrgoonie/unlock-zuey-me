/**
 * Deterministic rubric checks (content/schema.ts checkSchema). Pure functions: same answers → same score.
 * Each returns a 0..1 score and kind, specific Vietnamese feedback for the learner.
 */
import type { Mission, MissionStep, RubricCheck } from '../content/schema';
import type { Answers } from './types';

export interface CheckResult {
  score: number;
  feedback: string;
}

type Value = Answers[string][string] | undefined;

/** Code-point length of trimmed text (Vietnamese diacritics count as one character). */
export const textLength = (v: Value): number => (typeof v === 'string' ? [...v.trim()].length : 0);

/** List items: array entries or newline-separated lines, empty ones ignored. */
export function listItems(v: Value): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : [];
  return raw.map((x) => x.trim()).filter((x) => x.length > 0);
}

/** Lowercase, no diacritics (đ → d), collapsed spaces: "Kiểm Tra" matches "kiem tra". */
export function normalizeForMatch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const ratio = (have: number, need: number): number => (need <= 0 ? 1 : clamp01(have / need));

/** Minimum a field needs to count as filled, from its step definition. */
function fieldRequirement(step: MissionStep, field: string): { kind: 'text' | 'list'; min: number } {
  switch (step.type) {
    case 'guided-input': {
      const f = step.fields.find((x) => x.id === field);
      return { kind: f?.kind === 'list' ? 'list' : 'text', min: f?.min ?? 1 };
    }
    case 'ai-task': return { kind: 'text', min: step.capture.min };
    case 'verification': return { kind: 'text', min: field === step.notes.id ? step.notes.min : 1 };
    case 'reflection': return { kind: 'text', min: step.min };
    default: return { kind: 'text', min: 1 };
  }
}

function isFilled(step: MissionStep, field: string, v: Value): boolean {
  if (typeof v === 'number') return true;
  const req = fieldRequirement(step, field);
  const amount = req.kind === 'list' ? listItems(v).length : Array.isArray(v) ? v.length : textLength(v);
  return amount >= Math.max(1, req.min);
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

export function runCheck(mission: Mission, check: RubricCheck, answers: Answers): CheckResult {
  const step = mission.steps.find((s) => s.id === check.step);
  const a = answers[check.step] ?? {};
  if (!step) return { score: 0, feedback: 'Không tìm thấy bước cần chấm.' };

  switch (check.kind) {
    case 'fields_filled': {
      const missing = check.fields.filter((f) => !isFilled(step, f, a[f]));
      const score = ratio(check.fields.length - missing.length, check.fields.length);
      return { score, feedback: missing.length === 0 ? 'Bạn đã điền đủ các ô cần thiết.' : `Còn ${missing.length} ô chưa điền đủ ở bước "${step.title}".` };
    }
    case 'list_min': {
      const n = listItems(a[check.field]).length;
      return {
        score: ratio(n, check.min),
        feedback: n >= check.min ? `Bạn đã ghi ${n} ý, đủ yêu cầu.` : `Bạn mới ghi ${n}/${check.min} ý. Thêm ít nhất ${check.min - n} ý nữa (mỗi dòng một ý).`,
      };
    }
    case 'text_min': {
      const n = textLength(a[check.field]);
      return {
        score: ratio(n, check.min_chars),
        feedback: n >= check.min_chars ? 'Phần viết của bạn đủ ý.' : `Phần viết còn ngắn (${n}/${check.min_chars} ký tự). Hãy viết rõ hơn một chút.`,
      };
    }
    case 'contains_any': {
      const v = a[check.field];
      const text = normalizeForMatch(Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : '');
      const hit = check.terms.some((t) => text.includes(normalizeForMatch(t)));
      return { score: hit ? 1 : 0, feedback: hit ? 'Bạn đã nhắc đến ý quan trọng.' : `Thử nhắc đến một trong các ý: ${check.terms.join(', ')}.` };
    }
    case 'quiz_score': {
      if (step.type !== 'quiz') return { score: 0, feedback: 'Bước này không phải câu đố.' };
      const right = step.questions.filter((q) => {
        const v = a[q.id];
        const chosen = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
        return sameSet(chosen, q.correct);
      }).length;
      const total = step.questions.length;
      return { score: ratio(right, total), feedback: `Bạn trả lời đúng ${right}/${total} câu.` };
    }
    case 'claims_score': {
      if (step.type !== 'verification') return { score: 0, feedback: 'Bước này không phải bước kiểm chứng.' };
      const right = step.claims.filter((c) => a[c.id] === c.answer).length;
      const total = step.claims.length;
      return {
        score: ratio(right, total),
        feedback: right === total ? `Bạn đánh giá đúng cả ${total} nhận định.` : `Bạn đánh giá đúng ${right}/${total} nhận định. Xem lại phần giải thích của những câu chưa đúng.`,
      };
    }
    case 'prediction_correct': {
      if (step.type !== 'prediction') return { score: 0, feedback: 'Bước này không phải bước dự đoán.' };
      const ok = a.choice === step.correct;
      return { score: ok ? 1 : 0, feedback: ok ? 'Dự đoán của bạn chính xác.' : 'Dự đoán chưa đúng. Đọc phần giải thích để hiểu vì sao.' };
    }
  }
}
