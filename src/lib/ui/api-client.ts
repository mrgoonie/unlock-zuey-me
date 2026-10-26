/**
 * Typed browser client for /api/v1 (docs/api-contract.md). Every failure becomes an ApiError with the
 * contract's `code`, so islands branch on codes (conflict, budget_exceeded, ...) instead of parsing text.
 * Network failures map to code 'network' so callers can keep local drafts and retry.
 */
import type { LearnerMission } from '../learning/learner-mission-view';
import type {
  AnswerKey, AnswerKeyEntry, Answers, Evaluation, HintResult, LearnerContext, LearnerProfile, MissionListItem, MissionRun, SubmitResult,
} from '../learning/types';

/**
 * `answer_locked` (403) is sent only when a write changes an answer whose key was revealed; any other 403,
 * including a non-JSON one from an edge WAF/bot challenge, maps to the generic `forbidden`.
 */
export type ApiErrorCode =
  | 'unauthorized' | 'forbidden' | 'answer_locked' | 'not_found' | 'conflict' | 'invalid'
  | 'rate_limited' | 'budget_exceeded' | 'unavailable' | 'internal' | 'network';

const KNOWN_CODES = new Set<ApiErrorCode>([
  'unauthorized', 'forbidden', 'answer_locked', 'not_found', 'conflict', 'invalid', 'rate_limited', 'budget_exceeded',
  'unavailable', 'internal',
]);

/** Friendly Vietnamese fallback copy when the server sent no message (or we never reached it). */
const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  // 'network' also covers timeouts: the outcome is unknown, so retrying (same idempotency key) is safe.
  unauthorized: 'Phiên đăng nhập đã hết. Hãy tải lại trang.',
  forbidden: 'Bạn chưa thể làm việc này.',
  answer_locked: 'Bạn đã xem đáp án câu này nên không đổi câu trả lời được nữa.',
  not_found: 'Không tìm thấy nội dung này.',
  conflict: 'Dữ liệu vừa được cập nhật ở nơi khác.',
  invalid: 'Thông tin gửi lên chưa hợp lệ.',
  rate_limited: 'Bạn thao tác hơi nhanh. Đợi một chút rồi thử lại nhé.',
  budget_exceeded: 'Hôm nay đã hết lượt dùng AI trong app. Bạn vẫn có thể dùng ChatGPT bên ngoài.',
  unavailable: 'AI đang bận. Bài làm của bạn vẫn được giữ.',
  internal: 'Có lỗi không mong muốn. Bài làm của bạn vẫn được giữ.',
  network: 'Mạng chậm hoặc mất kết nối. Bài làm vẫn được lưu trên máy này, bạn thử lại nhé.',
};

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public status: number,
    /** The raw JSON body (e.g. 409 conflict carries the server's current `run`). */
    public body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Maps an HTTP status + parsed body to an ApiError. Exported for unit tests. */
export function toApiError(status: number, body: unknown): ApiError {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const rawCode = typeof err?.code === 'string' ? err.code : '';
  const code: ApiErrorCode = KNOWN_CODES.has(rawCode as ApiErrorCode)
    ? (rawCode as ApiErrorCode)
    : status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 429 ? 'rate_limited'
      : status === 403 ? 'forbidden' : status === 401 ? 'unauthorized' : status === 400 ? 'invalid'
        : status === 503 ? 'unavailable' : 'internal';
  const message = typeof err?.message === 'string' && err.message.trim() ? err.message : DEFAULT_MESSAGES[code];
  return new ApiError(code, message, status, body);
}

export const friendlyMessage = (e: unknown): string =>
  e instanceof ApiError ? e.message : DEFAULT_MESSAGES.internal;

/** Minimal fetch signature (injectable in tests). */
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/** Every call has a deadline so no screen can hang on a spinner; slow AI calls pass a longer one. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Hint deadline: above the server's worst case for one hint (OpenRouter 15 s + Workers AI 30 s fallback). */
export const HINT_TIMEOUT_MS = 55_000;

/**
 * Low-level request. `body` is JSON unless it is FormData. `timeoutMs` aborts slow calls (reported as
 * 'network', which callers treat as "outcome unknown, safe to retry with the same idempotency key").
 */
export async function request<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  opts: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<T> {
  const fetcher: Fetcher = opts.fetcher ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const init: RequestInit = {
    method, credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller?.signal,
  };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...init.headers, 'content-type': 'application/json' };
  }
  let res: Response;
  let text: string;
  try {
    res = await fetcher(path, init);
    // The deadline covers the body too: a stalled body must not hang the caller.
    text = await res.text();
  } catch {
    throw new ApiError('network', DEFAULT_MESSAGES.network, 0);
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw toApiError(res.status, data);
  return data as T;
}

const enc = encodeURIComponent;

/** Mission view without answer keys; `answerKey` holds revealed items, or all once the run is completed. */
export interface RunDetail { run: MissionRun; mission: LearnerMission; evaluation: Evaluation | null; answerKey: AnswerKey }
export type SubmitResponse = SubmitResult & { answerKey: AnswerKey };
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatReply { reply: string; model: string; remainingToday: number }
export interface Recap {
  period: string;
  missionsCompleted: number;
  xpGained: number;
  competencyDeltas: Record<string, number> | Array<{ id: string; delta: number }>;
  highlights: string[];
  reflections: string[];
}

/** One function per contract endpoint the learner UI uses. */
export const api = {
  updateProfile: (input: { profile?: Partial<LearnerProfile>; displayName?: string }) =>
    request<{ learner: LearnerContext }>('PATCH', '/api/v1/me/profile', input),
  listMissions: () => request<{ missions: MissionListItem[] }>('GET', '/api/v1/missions'),
  /** Opens a mission (open run, else latest completed run, else new); `again` starts a new run after completion. */
  startMission: (missionId: string, opts: { again?: boolean } = {}) =>
    request<{ run: MissionRun }>('POST', `/api/v1/missions/${enc(missionId)}/start`, opts.again ? { again: true } : {}),
  getRun: (runId: string) => request<RunDetail>('GET', `/api/v1/runs/${enc(runId)}`),
  saveAnswers: (runId: string, input: { stepId: string; answers: Answers[string]; currentStep?: string; rev: number }) =>
    request<{ run: MissionRun }>('PATCH', `/api/v1/runs/${enc(runId)}/answers`, input),
  /**
   * The coach can take ~45 s in the worst case (OpenRouter 15 s, then Workers AI 30 s), so the deadline sits
   * above it. A retry of an unlocked level returns the stored hint and is not charged again.
   */
  hint: (runId: string, stepId: string, level: 1 | 2 | 3 | 4) =>
    request<HintResult>('POST', `/api/v1/runs/${enc(runId)}/hints`, { stepId, level }, { timeoutMs: HINT_TIMEOUT_MS }),
  /** Reveals one quiz question / prediction answer; the server locks that answer from then on. */
  reveal: (runId: string, stepId: string, itemId: string) =>
    request<{ run: MissionRun; key: AnswerKeyEntry }>('POST', `/api/v1/runs/${enc(runId)}/reveal`, { stepId, itemId }),
  /** "Bỏ lượt này": abandons an open run (idempotent) so the mission can be started over. */
  abandonRun: (runId: string) => request<{ run: MissionRun }>('POST', `/api/v1/runs/${enc(runId)}/abandon`),
  submit: (runId: string, input: { idempotencyKey: string; confidence?: number; imageKeys?: string[] }) =>
    request<SubmitResponse>('POST', `/api/v1/runs/${enc(runId)}/submit`, input, { timeoutMs: 90_000 }),
  uploadEvidence: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ key: string }>('POST', '/api/v1/evidence/upload', form, { timeoutMs: 60_000 });
  },
  coachChat: (input: { runId?: string; stepId?: string; messages: ChatMessage[] }) =>
    request<ChatReply>('POST', '/api/v1/coach/chat', input, { timeoutMs: 45_000 }),
  viewConcept: (conceptId: string) => request<{ ok: true }>('POST', `/api/v1/concepts/${enc(conceptId)}/view`),
  recap: () => request<Recap>('GET', '/api/v1/recap?period=week'),
  requestCertificate: (displayName: string) => request<{ code: string; url: string }>('POST', '/api/v1/certificates', { displayName }),
  /** Fire-and-forget analytics; never throws (events are allow-listed server-side). */
  event: (name: string, extra: { missionId?: string; runId?: string; props?: Record<string, string | number | boolean> } = {}) =>
    request<{ ok: true }>('POST', '/api/v1/events', { name, ...extra }).catch(() => undefined),
};
