/**
 * Test doubles for the Worker env used by learning/coach/api tests: real SQL via the node:sqlite D1 helper,
 * in-memory KV and R2, a scripted Workers AI binding and an OpenRouter fetch fake.
 */
import { vi } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import type { LearnerContext } from '../../src/lib/learning/types';

export function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  } as unknown as KVNamespace;
}

export function fakeR2(): R2Bucket & { store: Map<string, { bytes: Uint8Array; type?: string }> } {
  const store = new Map<string, { bytes: Uint8Array; type?: string }>();
  const obj = (key: string) => {
    const o = store.get(key);
    if (!o) return null;
    return { key, size: o.bytes.byteLength, httpMetadata: { contentType: o.type }, body: new Blob([new Uint8Array(o.bytes)]).stream() };
  };
  return {
    store,
    put: vi.fn(async (key: string, bytes: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, { bytes, type: opts?.httpMetadata?.contentType });
      return obj(key);
    }),
    head: vi.fn(async (key: string) => obj(key)),
    get: vi.fn(async (key: string) => obj(key)),
  } as unknown as R2Bucket & { store: Map<string, { bytes: Uint8Array; type?: string }> };
}

export interface FakeEnv extends Env {
  AI: Ai & { run: ReturnType<typeof vi.fn> };
}

export function fakeEnv(overrides: Partial<Env> = {}): FakeEnv {
  return {
    DB: createTestD1(),
    CACHE: fakeKv(),
    OAUTH_KV: fakeKv(),
    EVIDENCE: fakeR2(),
    AI: { run: vi.fn(async () => { throw new Error('workers ai not scripted'); }) },
    ASSETS: {} as Fetcher,
    PUBLIC_SITE_URL: 'https://unlock.zuey.me',
    ZUEY_ISSUER: 'https://zuey.me',
    ADMIN_EMAILS: '',
    AI_DAILY_BUDGET_USD_PER_LEARNER: '0.30',
    AI_DAILY_BUDGET_USD_GLOBAL: '5',
    VAPID_SUBJECT: 'mailto:test@example.com',
    OPENROUTER_API_KEY: 'test-key',
    ...overrides,
  } as unknown as FakeEnv;
}

export async function seedLearner(
  db: D1Database, id: string, opts: { observerConsent?: boolean; isAdmin?: boolean; timezone?: string } = {},
): Promise<LearnerContext> {
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO learners (id, kind, observer_consent, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, 'guest', opts.observerConsent ? 1 : 0, JSON.stringify(opts.timezone ? { timezone: opts.timezone } : {}), now, now).run();
  return {
    id, kind: 'guest', email: null, displayName: null, avatarUrl: null, isAdmin: !!opts.isAdmin,
    observerConsent: !!opts.observerConsent, profile: opts.timezone ? { timezone: opts.timezone } : {},
  };
}

/** An OpenRouter fetch fake answering every call with `content(body)`; records request bodies. */
export function openRouterFetch(content: (body: Record<string, unknown>) => string, usage = { prompt_tokens: 1000, completion_tokens: 200 }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    return Response.json({ model: body.model, choices: [{ message: { content: content(body) } }], usage });
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

export const failingFetch = (status = 503) =>
  vi.fn(async () => new Response('upstream down', { status })) as unknown as typeof fetch;

/** Grader JSON giving every requested criterion the same score. */
export function gradeAll(body: Record<string, unknown>, score: number): string {
  const rf = body.response_format as { json_schema: { schema: { properties: { criteria: { items: { properties: { id: { enum: string[] } } } } } } } } | undefined;
  const ids = rf?.json_schema.schema.properties.criteria.items.properties.id.enum ?? [];
  return JSON.stringify({
    criteria: ids.map((id) => ({ id, score, feedback: 'Bạn làm khá tốt phần này.' })),
    feedback: 'Bài làm rõ ràng.', strengths: ['Ràng buộc cụ thể'], improvements: ['Ghi rõ nguồn đã kiểm tra'],
  });
}

/** Answers that satisfy every deterministic check of content/missions/plan-weekend.yaml. */
export const planWeekendAnswers = {
  constraints: { goal: 'Nghỉ ngơi và đi chơi cùng gia đình', constraints: ['Ngân sách 500k', 'Về trước 18h', 'Đi cùng bé 5 tuổi'], location: 'Quận 7, TP.HCM' },
  'ask-ai': { ai_answer: 'Thứ Bảy 8h: ăn sáng ở quán phở gần nhà (60k). 10h: công viên. 12h: ăn trưa. Chủ Nhật 9h: bảo tàng, 15h về nhà nghỉ ngơi.' },
  verify: {
    'claim-hours': 'needs_lookup', 'claim-walk': 'verified', 'claim-price': 'needs_lookup', 'claim-weather': 'insufficient',
    check_notes: 'Mình tra Google Maps: bảo tàng mở 8h30 và đóng cửa thứ Hai, nên dời sang chiều Chủ Nhật.',
  },
  adjust: { change: 'Nếu Chủ Nhật trời mưa thì sao?', revised: 'AI đổi công viên thành khu vui chơi trong nhà, giữ ngân sách. Mình thấy hợp lý.' },
  reflect: { lesson: 'Lần sau mình sẽ ghi ngân sách ngay từ đầu và hỏi AI chỗ nào cần tự kiểm tra.' },
};
