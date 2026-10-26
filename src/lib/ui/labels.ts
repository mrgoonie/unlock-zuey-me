/** Vietnamese display labels shared by learner pages and islands. */
import type { CompetencyId, Concept } from '../content/schema';
import type { MissionListItem } from '../learning/types';

export const COMPETENCY_LABEL: Record<CompetencyId, { name: string; emoji: string; hint: string }> = {
  discover: { name: 'Khám phá', emoji: '🧭', hint: 'Biết AI làm được gì cho việc của mình' },
  describe: { name: 'Mô tả', emoji: '✍️', hint: 'Nói rõ mình cần gì, kèm ràng buộc' },
  delegate: { name: 'Giao việc', emoji: '🤝', hint: 'Chia việc hợp lý giữa mình và AI' },
  verify: { name: 'Kiểm chứng', emoji: '🔎', hint: 'Biết chỗ nào phải tự tra lại' },
  operate: { name: 'Điều chỉnh', emoji: '🔧', hint: 'Đổi điều kiện và làm lại cùng AI' },
  reflect: { name: 'Đúc kết', emoji: '💡', hint: 'Rút ra bài học cho lần sau' },
};

export const RISK_LABEL: Record<MissionListItem['riskTier'], string> = {
  low: 'rủi ro thấp',
  medium: 'rủi ro vừa',
  high: 'cần cẩn thận',
};

export const MISSION_STATUS_LABEL: Record<MissionListItem['status'], string> = {
  new: 'Mới',
  in_progress: 'Đang làm',
  completed: 'Đã xong',
};

export const CONCEPT_GROUP_LABEL: Record<Concept['group'], string> = {
  fundamentals: 'Nền tảng',
  'prompt-knowledge': 'Cách hỏi AI',
  'agents-integration': 'Agent & tích hợp',
  software: 'Phần mềm',
  advanced: 'Nâng cao',
};

export const CONCEPT_LAYER_LABEL: Record<Concept['layer'], { name: string; hint: string }> = {
  foundation: { name: 'Nền tảng', hint: 'Kiến thức lâu bền, ít thay đổi' },
  'just-in-time': { name: 'Khi cần mới học', hint: 'Chỉ cần khi bạn gặp việc liên quan' },
  'current-fact': { name: 'Thông tin thời điểm', hint: 'Có thể thay đổi nhanh, nên kiểm tra lại' },
};

export const LAB_LABEL: Record<NonNullable<Concept['lab']>, { name: string; emoji: string; tagline: string }> = {
  'token-predictor': { name: 'Máy đoán chữ', emoji: '🔮', tagline: 'AI “đoán từ tiếp theo” thế nào?' },
  'context-lab': { name: 'Phòng thí nghiệm ngữ cảnh', emoji: '🧠', tagline: 'AI nhớ được gì trong một cuộc trò chuyện?' },
  'hallucination-detective': { name: 'Thám tử ảo giác', emoji: '🕵️', tagline: 'Bắt lỗi khi AI bịa thông tin' },
};

export const ONBOARDING_QUESTIONS = {
  goal: {
    title: 'Bạn muốn dùng AI cho việc gì nhất?',
    options: [
      { value: 'everyday-life', emoji: '🏡', label: 'Việc đời sống', hint: 'Lên kế hoạch, nấu ăn, mua sắm, nhắn tin' },
      { value: 'work', emoji: '💼', label: 'Công việc', hint: 'Soạn email, tóm tắt, sắp xếp việc' },
      { value: 'curious', emoji: '✨', label: 'Chỉ tò mò thôi', hint: 'Muốn hiểu AI làm được gì' },
    ],
  },
  familiarity: {
    title: 'Bạn đã dùng AI (như ChatGPT) bao giờ chưa?',
    options: [
      { value: 'never', emoji: '🌱', label: 'Chưa bao giờ', hint: 'Mình sẽ đi từng bước thật chậm' },
      { value: 'basic', emoji: '🙂', label: 'Thỉnh thoảng hỏi vài câu', hint: 'Biết mở và gõ câu hỏi' },
      { value: 'regular', emoji: '🚀', label: 'Dùng khá thường xuyên', hint: 'Muốn dùng hiệu quả và chắc chắn hơn' },
    ],
  },
  obstacle: {
    title: 'Điều gì làm bạn ngại dùng AI nhất?',
    options: [
      { value: 'dont-know-what-to-ask', emoji: '🤔', label: 'Không biết nên hỏi gì', hint: 'Mở ra rồi không biết gõ gì' },
      { value: 'dont-trust-answers', emoji: '🧐', label: 'Không biết có tin được không', hint: 'Sợ AI nói sai mà mình không biết' },
      { value: 'no-time', emoji: '⏱️', label: 'Không có nhiều thời gian', hint: 'Cần việc ngắn, dùng được ngay' },
      { value: 'too-technical', emoji: '🧩', label: 'Thấy nó quá kỹ thuật', hint: 'Nhiều từ lạ, khó hiểu' },
    ],
  },
} satisfies Record<'goal' | 'familiarity' | 'obstacle', {
  title: string;
  options: Array<{ value: string; emoji: string; label: string; hint: string }>;
}>;

/** "Hôm nay" style relative date in Vietnamese for ISO strings. */
export function formatDateVi(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('vi-VN', { day: 'numeric', month: 'long', year: 'numeric' });
}

export const pct = (score01: number): number => Math.round(Math.max(0, Math.min(1, score01)) * 100);
