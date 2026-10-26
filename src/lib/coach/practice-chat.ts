/**
 * In-app practice chat: a short, beginner-friendly assistant so learners can practise prompting without
 * leaving the app. History is client-held, so the service drops assistant turns the server never produced
 * (see practice-chat-service.ts) and only the newest messages within a message and character budget are
 * sent; output tokens are bounded.
 */
import { runAi, type AiDeps } from './ai-gateway';
import type { ChatMessage } from './ai-clients';
import { COACH_MODELS, WORKERS_AI_MODEL } from './ai-models';

export interface PracticeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const PRACTICE_LIMITS = {
  historyMessages: 12,
  messageChars: 4000,
  /** Total characters of history sent to the model (newest first; the last user message always fits). */
  historyChars: 8000,
  maxOutputTokens: 700,
  /** Practice messages per learner per UTC day. */
  dailyMessages: 60,
} as const;

export const PRACTICE_SYSTEM_PROMPT = [
  'Bạn là trợ lý AI thân thiện trong app AI Unlocked, nơi người mới tập dùng AI cho việc thật.',
  'Luôn trả lời bằng tiếng Việt có dấu đầy đủ, ngắn gọn (tối đa khoảng 200 từ), dễ hiểu, tránh thuật ngữ khó; nếu buộc phải dùng thì giải thích ngắn.',
  'Làm đúng việc người dùng nhờ. Khi câu trả lời có dữ kiện dễ thay đổi hoặc dễ sai (giờ mở cửa, giá, thời tiết, địa chỉ, số liệu, sức khoẻ, pháp luật, tài chính),',
  'hãy nói rõ chỗ nào bạn không chắc và nhắc người dùng tự kiểm tra lại từ nguồn chính thức.',
  'Không hỏi hay lưu thông tin cá nhân nhạy cảm (số điện thoại, địa chỉ nhà, số tài khoản).',
].join(' ');

export function buildPracticeMessages(history: PracticeMessage[], context?: string): ChatMessage[] {
  const recent: ChatMessage[] = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0 && recent.length < PRACTICE_LIMITS.historyMessages; i--) {
    const content = history[i].content.slice(0, PRACTICE_LIMITS.messageChars);
    if (recent.length > 0 && chars + content.length > PRACTICE_LIMITS.historyChars) break;
    chars += content.length;
    recent.unshift({ role: history[i].role, content });
  }
  const system = context ? `${PRACTICE_SYSTEM_PROMPT}\nNgười dùng đang làm mission: ${context}` : PRACTICE_SYSTEM_PROMPT;
  return [{ role: 'system', content: system }, ...recent];
}

export async function practiceReply(deps: AiDeps, input: {
  learnerId: string; runId?: string; missionId?: string; context?: string; messages: PracticeMessage[];
}): Promise<{ reply: string; model: string }> {
  const r = await runAi(deps, {
    purpose: 'chat',
    learnerId: input.learnerId,
    runId: input.runId,
    missionId: input.missionId,
    messages: buildPracticeMessages(input.messages, input.context),
    maxTokens: PRACTICE_LIMITS.maxOutputTokens,
    temperature: 0.6,
    openRouterModels: COACH_MODELS,
    workersAiModel: WORKERS_AI_MODEL,
    parse: (text) => {
      const t = text.trim();
      if (!t) throw new Error('empty reply');
      return t;
    },
    timeoutMs: 20_000,
  });
  return { reply: r.value, model: r.model };
}
