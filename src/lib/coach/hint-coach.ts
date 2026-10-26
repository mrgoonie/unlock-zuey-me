/**
 * Four-level hint ladder. The AI hint is grounded on the step, the authored hint for that level and the
 * learner's current answers. Levels 1–2 never do the task for the learner. Any AI failure, budget limit or
 * rate limit falls back to the authored static hint (origin 'static').
 */
import type { Mission, MissionStep } from '../content/schema';
import type { Answers, HintResult } from '../learning/types';
import { runAi, type AiDeps } from './ai-gateway';
import type { ChatMessage } from './ai-clients';
import { COACH_MODELS, WORKERS_AI_MODEL } from './ai-models';
import { allowRequest } from './rate-limit';
import { renderStepAnswers, stepInstruction } from './step-context';
import { dataEnd, dataStart, newBoundary, untrustedDataRule } from './untrusted-text';

type Level = HintResult['level'];

const LEVEL_RULES: Record<Level, string> = {
  1: 'Nấc 1 (gợi mở): chỉ đặt MỘT câu hỏi gợi mở kiểu Socratic để bạn tự nghĩ ra hướng đi. Tuyệt đối không đưa đáp án, không viết hộ.',
  2: 'Nấc 2 (bước tiếp theo): chỉ ra MỘT bước cụ thể kế tiếp, dựa trên những gì bạn đã viết. Không viết hộ câu trả lời hay câu lệnh hoàn chỉnh.',
  3: 'Nấc 3 (ví dụ tương tự): đưa một ví dụ ngắn cho một tình huống KHÁC nhưng tương tự, không phải đáp án cho bài của bạn.',
  4: 'Nấc 4 (giải thích trực tiếp): giải thích rõ cần làm gì và vì sao, có thể đưa mẫu câu có chỗ trống để bạn tự điền nội dung của mình.',
};

export function buildHintMessages(input: {
  mission: Mission; step: MissionStep; level: Level; stepAnswers: Answers[string] | undefined; boundary: string;
}): ChatMessage[] {
  const { mission, step, level, boundary } = input;
  const system = [
    'Bạn là huấn luyện viên kiên nhẫn trong app AI Unlocked, giúp người mới tự làm việc thật với AI và biết kiểm chứng.',
    'Trả lời bằng tiếng Việt có dấu đầy đủ, xưng "mình", gọi người học là "bạn", tối đa 3 câu ngắn, giọng ấm áp, không dùng markdown.',
    LEVEL_RULES[level],
    'Dựa vào gợi ý gốc của bài; không bịa thông tin mới về địa điểm, giá hay số liệu.',
    untrustedDataRule(boundary),
  ].join(' ');
  const user = [
    `Mission: ${mission.title}`,
    `Bước: ${step.title}`,
    `Yêu cầu của bước: ${stepInstruction(step)}`,
    `Gợi ý gốc nấc ${level} (dùng làm nền): ${step.hints[level - 1]}`,
    `Bài làm hiện tại của người học:\n${renderStepAnswers(step, input.stepAnswers, boundary)}`,
    `Hãy viết gợi ý nấc ${level}.`,
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Model text → hint, rejecting empty/oversized output or output echoing the data markers. */
export function parseHintText(text: string, boundary: string): string {
  const t = text.trim();
  if (t.length === 0 || t.length > 1200 || t.includes(dataStart(boundary)) || t.includes(dataEnd(boundary))) {
    throw new Error('unusable hint output');
  }
  return t;
}

export async function generateHint(deps: AiDeps, input: {
  learnerId: string; runId: string; mission: Mission; step: MissionStep; level: Level; stepAnswers: Answers[string] | undefined;
}): Promise<HintResult & { model: string | null }> {
  const fallback = { level: input.level, text: input.step.hints[input.level - 1], origin: 'static' as const, model: null };
  const now = deps.now?.() ?? new Date();
  if (!(await allowRequest(deps.env.CACHE, 'hint', input.learnerId, now))) return fallback;
  const boundary = newBoundary();
  try {
    const r = await runAi(deps, {
      purpose: 'hint',
      learnerId: input.learnerId,
      runId: input.runId,
      missionId: input.mission.id,
      messages: buildHintMessages({ ...input, boundary }),
      maxTokens: 350,
      temperature: 0.4,
      openRouterModels: COACH_MODELS,
      workersAiModel: WORKERS_AI_MODEL,
      parse: (text) => parseHintText(text, boundary),
      timeoutMs: 15_000,
    });
    return { level: input.level, text: r.value, origin: 'ai', model: r.model };
  } catch (err) {
    console.warn('hint falls back to static', err instanceof Error ? err.message : err);
    return fallback;
  }
}
