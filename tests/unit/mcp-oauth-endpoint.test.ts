/**
 * /mcp end to end through the real OAuth provider (in-memory KV, real-schema D1): no token → 401 challenge,
 * tokens bind to one learner, learn:read tokens cannot write. The learning service is mocked.
 */
import { registerHooks } from 'node:module';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';

// The provider imports `cloudflare:workers` (WorkerEntrypoint); give Node a stub for that specifier.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,export class WorkerEntrypoint {}; export const env = {};', shortCircuit: true };
    }
    return next(specifier, context);
  },
});

vi.mock('../../src/lib/learning/service', () => ({
  getProgress: vi.fn(), listMissions: vi.fn(), startMission: vi.fn(), getRun: vi.fn(),
  saveAnswers: vi.fn(), requestHint: vi.fn(), submitEvidence: vi.fn(),
}));

const learning = await import('../../src/lib/learning/service');
const { LearningError } = await import('../../src/lib/learning/types');
const { pkceChallenge } = await import('../../src/lib/identity/identity-crypto');
const { MCP_RESOURCE } = await import('../../src/lib/mcp/mcp-scopes');

type Provider = { fetch(r: Request, e: Env, c: ExecutionContext): Promise<Response> };
let provider: Provider;
let getOAuthHelpers: typeof import('../../src/lib/mcp/oauth-options').getOAuthHelpers;

function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, opts?: unknown) {
      const v = store.get(key);
      if (v === undefined) return null;
      const type = typeof opts === 'string' ? opts : (opts as { type?: string } | undefined)?.type;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list(opts?: { prefix?: string }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(opts?.prefix ?? '')).map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let env: Env;
const REDIRECT = 'https://client.example/cb';

async function seedMember(db: D1Database, id: string) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO learners (id, kind, zuey_sub, email, created_at, updated_at) VALUES (?, 'member', ?, ?, ?, ?)`)
    .bind(id, `sub-${id}`, `${id}@example.com`, now, now).run();
}

/** Runs the authorization-code flow for `learnerId` with `scope` and returns the access token. */
async function issueToken(learnerId: string, scope: string[]): Promise<string> {
  const oauth = getOAuthHelpers(env);
  const client = await oauth.createClient({ redirectUris: [REDIRECT], tokenEndpointAuthMethod: 'none', clientName: 'Test client' });
  const verifier = 'v'.repeat(20) + crypto.randomUUID();
  const authUrl = new URL('https://unlock.zuey.me/authorize');
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: client.clientId, redirect_uri: REDIRECT, scope: scope.join(' '), state: 'st',
    code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', resource: MCP_RESOURCE,
  })) authUrl.searchParams.set(k, v);
  const request = await oauth.parseAuthRequest(new Request(authUrl));
  const { redirectTo } = await oauth.completeAuthorization({ request, userId: learnerId, metadata: {}, scope, props: { learnerId } });
  const code = new URL(redirectTo).searchParams.get('code') ?? '';
  const res = await provider.fetch(new Request('https://unlock.zuey.me/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.clientId, code_verifier: verifier, resource: MCP_RESOURCE,
    }),
  }), env, ctx);
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Legacy (2025-era) stateless JSON-RPC call; parses JSON or SSE responses. */
async function callTool(token: string | null, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await provider.fetch(new Request('https://unlock.zuey.me/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), env, ctx);
  const text = await res.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  const body = data ? JSON.parse(data.slice(5)) : text ? JSON.parse(text) : null;
  return { res, body };
}

beforeAll(async () => {
  const { OAuthProvider } = await import('@cloudflare/workers-oauth-provider');
  const options = await import('../../src/lib/mcp/oauth-options');
  getOAuthHelpers = options.getOAuthHelpers;
  provider = new OAuthProvider<Env>(options.buildOAuthOptions({ fetch: () => new Response('astro') }));
});

beforeEach(async () => {
  vi.clearAllMocks();
  const db = createTestD1();
  await seedMember(db, 'lrn_a');
  await seedMember(db, 'lrn_b');
  env = { DB: db, OAUTH_KV: memoryKv(), CACHE: memoryKv(), ADMIN_EMAILS: '' } as unknown as Env;
});

describe('/mcp', () => {
  it('rejects a request without a token with a 401 resource_metadata challenge', async () => {
    const { res } = await callTool(null, 'get_profile', {});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://unlock.zuey.me/.well-known/oauth-protected-resource/mcp"',
    );
    expect(learning.getProgress).not.toHaveBeenCalled();
  });

  it('serves protected resource metadata for the canonical resource', async () => {
    const res = await provider.fetch(new Request('https://unlock.zuey.me/.well-known/oauth-protected-resource/mcp'), env, ctx);
    const doc = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(doc.resource).toBe(MCP_RESOURCE);
    expect(doc.authorization_servers).toEqual(['https://unlock.zuey.me']);
  });

  it('binds the token to its learner: get_run uses learner A only and B\'s run is not_found', async () => {
    const token = await issueToken('lrn_a', ['learn:read', 'learn:write']);
    vi.mocked(learning.getRun).mockRejectedValue(new LearningError('not_found', 'Không tìm thấy lượt làm này.'));
    const { res, body } = await callTool(token, 'get_run', { run_id: 'run_of_b' });
    expect(res.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error.code).toBe('not_found');
    expect(learning.getRun).toHaveBeenCalledTimes(1);
    const [, learnerArg, runArg] = vi.mocked(learning.getRun).mock.calls[0];
    expect(learnerArg.id).toBe('lrn_a');
    expect(runArg).toBe('run_of_b');
  });

  it('a learn:read token cannot start a mission or submit evidence', async () => {
    const token = await issueToken('lrn_a', ['learn:read']);
    for (const [name, args] of [
      ['start_mission', { mission_id: 'plan-weekend' }],
      ['submit_evidence', { run_id: 'run_x', answers: {}, idempotency_key: 'key-12345678' }],
    ] as const) {
      const { res } = await callTool(token, name, args);
      expect(res.status, `${name} must be refused`).toBe(403);
      expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
      expect(res.headers.get('www-authenticate')).toContain('scope="learn:write"');
    }
    expect(learning.startMission).not.toHaveBeenCalled();
    expect(learning.submitEvidence).not.toHaveBeenCalled();
  });

  it('a learn:write token starts a mission over MCP with source "mcp"', async () => {
    const token = await issueToken('lrn_a', ['learn:read', 'learn:write']);
    vi.mocked(learning.startMission).mockResolvedValue({ id: 'run_1', status: 'started' } as never);
    const { body } = await callTool(token, 'start_mission', { mission_id: 'plan-weekend' });
    expect(body.result.structuredContent.run.id).toBe('run_1');
    const [, learnerArg, missionArg, source] = vi.mocked(learning.startMission).mock.calls[0];
    expect([learnerArg.id, missionArg, source]).toEqual(['lrn_a', 'plan-weekend', 'mcp']);
  });

  it('serves 2026-07-28 (modern, envelope) requests too', async () => {
    const token = await issueToken('lrn_a', ['learn:read']);
    vi.mocked(learning.listMissions).mockResolvedValue([]);
    const res = await provider.fetch(new Request('https://unlock.zuey.me/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'list_missions',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: {
          name: 'list_missions', arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
          },
        },
      }),
    }), env, ctx);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).toContain('"missions":[]');
    expect(vi.mocked(learning.listMissions).mock.calls[0][1].id).toBe('lrn_a');
  });

  it('rejects a foreign browser Origin with 403', async () => {
    const token = await issueToken('lrn_a', ['learn:read']);
    const { res } = await callTool(token, 'get_profile', {}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(learning.getProgress).not.toHaveBeenCalled();
  });

  it('revokes access when the learner is gone', async () => {
    const token = await issueToken('lrn_b', ['learn:read']);
    await env.DB.prepare('UPDATE learners SET deleted_at = ? WHERE id = ?').bind(new Date().toISOString(), 'lrn_b').run();
    const { res } = await callTool(token, 'get_profile', {});
    expect(res.status).toBe(401);
  });
});
