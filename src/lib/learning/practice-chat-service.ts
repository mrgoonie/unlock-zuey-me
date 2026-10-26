/**
 * Practice chat for learners: validation, ownership of the optional run, daily cap, storage and events.
 * The client sends the conversation history; assistant turns are kept only when they match a reply this
 * server stored for the learner recently, so a client cannot script the "assistant" side of the prompt.
 */
import { getMission } from '../content/loader';
import { AiUnavailableError, type AiDeps } from '../coach/ai-gateway';
import { PRACTICE_LIMITS, practiceReply, type PracticeMessage } from '../coach/practice-chat';
import { allowRequest } from '../coach/rate-limit';
import { stepInstruction } from '../coach/step-context';
import { newId, nowIso } from '../db/ids';
import { recordEventSafe } from '../observer/events';
import { findStep } from './answers-validation';
import { loadRun } from './mission-runs';
import { LearningError, type LearnerContext } from './types';

export interface PracticeChatInput {
  runId?: string;
  stepId?: string;
  messages: PracticeMessage[];
}

export interface PracticeChatResult {
  reply: string;
  model: string;
  remainingToday: number;
}

/** Messages accepted per request; only the newest PRACTICE_LIMITS.historyMessages reach the model. */
export const MAX_REQUEST_MESSAGES = 20;

function validateMessages(messages: unknown): PracticeMessage[] {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_REQUEST_MESSAGES) {
    throw new LearningError('invalid', `Cần 1–${MAX_REQUEST_MESSAGES} tin nhắn.`);
  }
  for (const m of messages) {
    const ok = m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
      && m.content.trim().length > 0 && m.content.length <= PRACTICE_LIMITS.messageChars;
    if (!ok) throw new LearningError('invalid', `Mỗi tin nhắn cần role user/assistant và nội dung 1–${PRACTICE_LIMITS.messageChars} ký tự.`);
  }
  if (messages[messages.length - 1].role !== 'user') throw new LearningError('invalid', 'Tin nhắn cuối phải là của bạn.');
  return messages as PracticeMessage[];
}

/** How far back a client-held assistant turn may come from, and how many stored replies are compared. */
const VERIFIED_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const VERIFIED_REPLY_LOOKBACK = 50;

/** Drops assistant turns that are not replies the server stored for this learner within the window. */
export async function stripUnverifiedAssistantTurns(
  db: D1Database, learnerId: string, messages: PracticeMessage[], now: Date,
): Promise<PracticeMessage[]> {
  if (!messages.some((m) => m.role === 'assistant')) return messages;
  const since = new Date(now.getTime() - VERIFIED_REPLY_WINDOW_MS).toISOString();
  const { results } = await db.prepare(
    `SELECT content FROM coach_messages WHERE learner_id = ? AND channel = 'practice' AND role = 'assistant' AND created_at >= ?
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(learnerId, since, VERIFIED_REPLY_LOOKBACK).all<{ content: string }>();
  const stored = new Set(results.map((r) => r.content));
  return messages.filter((m) => m.role === 'user' || stored.has(m.content));
}

async function usedToday(db: D1Database, learnerId: string, now: Date): Promise<number> {
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM coach_messages WHERE learner_id = ? AND channel = 'practice' AND role = 'user' AND created_at >= ?`,
  ).bind(learnerId, dayStart).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function sendPracticeChat(deps: AiDeps, learner: LearnerContext, input: PracticeChatInput): Promise<PracticeChatResult> {
  const messages = validateMessages(input.messages);
  const db = deps.env.DB;
  const now = deps.now?.() ?? new Date();

  let context: string | undefined;
  let missionId: string | undefined;
  let stepId: string | undefined;
  if (input.runId) {
    const run = await loadRun(deps, learner, input.runId);
    const mission = getMission(run.missionId);
    missionId = run.missionId;
    if (mission) {
      const step = input.stepId ? findStep(mission, input.stepId) : undefined;
      stepId = step?.id;
      context = (step ? `${mission.title} — bước "${step.title}": ${stepInstruction(step)}` : mission.title).slice(0, 600);
    }
  }

  if (!(await allowRequest(deps.env.CACHE, 'chat', learner.id, now))) {
    throw new LearningError('rate_limited', 'Bạn gửi hơi nhanh. Đợi một phút rồi thử lại nhé.');
  }
  const used = await usedToday(db, learner.id, now);
  if (used >= PRACTICE_LIMITS.dailyMessages) {
    throw new LearningError('budget_exceeded', 'Bạn đã dùng hết lượt chat luyện tập hôm nay. Hẹn bạn ngày mai nhé!');
  }

  const history = await stripUnverifiedAssistantTurns(db, learner.id, messages, now);
  let result: { reply: string; model: string };
  try {
    result = await practiceReply(deps, { learnerId: learner.id, runId: input.runId, missionId, context, messages: history });
  } catch (err) {
    if (err instanceof AiUnavailableError && err.reason === 'budget') {
      throw new LearningError('budget_exceeded', 'Trợ lý đã hết lượt cho hôm nay. Bạn vẫn có thể dùng ChatGPT, Gemini hay Claude bên ngoài nhé.');
    }
    throw new LearningError('unavailable', 'Trợ lý đang bận. Bạn thử lại sau ít phút hoặc dùng AI bên ngoài nhé.');
  }

  const at = nowIso(now);
  const insert = (role: 'user' | 'assistant', content: string, model: string | null) => db.prepare(
    `INSERT INTO coach_messages (id, learner_id, run_id, step_id, channel, role, content, hint_level, model, created_at)
     VALUES (?, ?, ?, ?, 'practice', ?, ?, NULL, ?, ?)`,
  ).bind(newId('cm'), learner.id, input.runId ?? null, stepId ?? null, role, content, model, at);
  try {
    await db.batch([insert('user', messages[messages.length - 1].content, null), insert('assistant', result.reply, result.model)]);
  } catch (err) {
    console.error('store practice chat failed', err);
  }
  await recordEventSafe(db, {
    learnerId: learner.id, name: 'coach.chat_sent', runId: input.runId, missionId,
    props: { stepId: stepId ?? null, chars: messages[messages.length - 1].content.length, model: result.model },
  });
  return { ...result, remainingToday: Math.max(0, PRACTICE_LIMITS.dailyMessages - used - 1) };
}
