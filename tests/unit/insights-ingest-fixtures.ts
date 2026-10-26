/**
 * Shared doubles for the insights ingest/consent/pairing tests (not a test file itself): a KV fake with
 * delete and TTL, an env builder, member seeding, a valid v1 turn payload and request builders.
 */
import { createHash } from 'node:crypto';
import { createTestD1 } from '../helpers/d1-sqlite';
import { resetFallbackLimiter } from '../../src/lib/identity/request-rate-limits';
import type { IngestTurnV1 } from '../../src/lib/insights/ingest-contract';

export const NOW = new Date('2026-10-26T16:00:00.000Z');
export const SITE = 'https://unlock.zuey.me';
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** In-memory KV with get/put/delete and expirationTtl measured against a settable clock. */
export function memoryKv(clock: () => number = () => NOW.getTime()) {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const kv = {
    async get(key: string) {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt !== null && e.expiresAt <= clock()) {
        store.delete(key);
        return null;
      }
      return e.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) throw new Error('expirationTtl below 60');
      store.set(key, { value, expiresAt: opts?.expirationTtl ? clock() + opts.expirationTtl * 1000 : null });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}

export interface TestEnv {
  env: Env;
  db: D1Database;
  store: Map<string, { value: string; expiresAt: number | null }>;
}

export function makeEnv(over: Partial<Env> = {}): TestEnv {
  resetFallbackLimiter();
  const db = createTestD1();
  const { kv, store } = memoryKv();
  const env = {
    DB: db, CACHE: kv, INSIGHTS_MODE: 'on', ADMIN_EMAILS: 'admin@example.com', PUBLIC_SITE_URL: SITE, ...over,
  } as unknown as Env;
  return { env, db, store };
}

export async function seedMember(db: D1Database, id: string, opts: { kind?: 'member' | 'guest'; email?: string; analysis?: boolean } = {}) {
  const ts = NOW.toISOString();
  await db.prepare(`INSERT INTO learners (id, kind, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, opts.kind ?? 'member', opts.email ?? `${id}@example.com`, ts, ts).run();
  if (opts.analysis) {
    await db.prepare(`INSERT INTO insight_consents (learner_id, analysis, analysis_at, updated_at) VALUES (?, 1, ?, ?)`).bind(id, ts, ts).run();
  }
}

export function turnPayload(over: Partial<IngestTurnV1> & { turnOver?: Partial<IngestTurnV1['turn']> } = {}): IngestTurnV1 {
  const { turnOver, ...rest } = over;
  return {
    v: 1,
    adapter: 'claude-code',
    adapterVersion: '0.1.0',
    idempotencyKey: sha('session-1:prompt-1'),
    sessionRef: sha('session-1salt'),
    sentAt: NOW.toISOString(),
    turnEndedAt: new Date(NOW.getTime() - 2_000).toISOString(),
    turn: {
      userPrompt: 'Giúp mình lập kế hoạch cuối tuần',
      assistantFinal: 'Đây là kế hoạch gợi ý cho bạn.',
      tools: [{ name: 'mcp__ai-unlocked__start_mission', ok: true, count: 1 }],
      platform: { mcpTools: ['start_mission'], missionId: 'plan-weekend' },
      ...turnOver,
    },
    redaction: { count: 0, kinds: [] },
    truncated: false,
    stopHookActive: false,
    ...rest,
  };
}

export function ingestRequest(path: string, opts: { token?: string; body?: unknown; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'node', 'cf-connecting-ip': '203.0.113.9', ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  return new Request(`${SITE}${path}`, { method: opts.method ?? 'POST', headers, body });
}

/** Calls an Astro route handler with a minimal context. */
export function callRoute(
  route: (c: never) => Response | Promise<Response>,
  env: Env,
  request: Request,
  extra: { learner?: unknown; params?: Record<string, string> } = {},
): Promise<Response> {
  return Promise.resolve(route({
    request, url: new URL(request.url), params: extra.params ?? {}, locals: { learner: extra.learner, runtime: { env } },
  } as never));
}

export const count = async (db: D1Database, sql: string, ...binds: unknown[]) => Number(await db.prepare(sql).bind(...binds).first('n'));
