/**
 * Ingest authentication and replay defenses: bearer token (hash only, revoked/expired → 401), Origin → 403,
 * feature gating per INSIGHTS_MODE (404), the token binding the learner, sentAt window, rate limits,
 * status and self-revoke.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as turnsRoute } from '../../src/pages/api/ingest/v1/turns';
import { GET as statusRoute } from '../../src/pages/api/ingest/v1/status';
import { DELETE as tokenRoute } from '../../src/pages/api/ingest/v1/token';
import { createToken, hashToken, listTokens, resolveToken } from '../../src/lib/insights/ingest-tokens';
import { INGEST_TOKEN_PATTERN } from '../../src/lib/insights/ingest-contract';
import { learnerPolicy } from '../../src/lib/identity/request-policy';
import { callRoute, count, ingestRequest, makeEnv, NOW, seedMember, sha, turnPayload, type TestEnv } from './insights-ingest-fixtures';

let t: TestEnv;
let tokenA: string;

const turns = (body: unknown, opts: { token?: string; headers?: Record<string, string> } = {}) =>
  callRoute(turnsRoute, t.env, ingestRequest('/api/ingest/v1/turns', { token: 'token' in opts ? opts.token : tokenA, body, headers: opts.headers }));
const reason = async (res: Response) => ((await res.json()) as { error: { reason: string } }).error.reason;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = makeEnv();
  await seedMember(t.db, 'lrn_a', { analysis: true });
  await seedMember(t.db, 'lrn_b', { analysis: true });
  tokenA = (await createToken(t.db, 'lrn_a', 'MacBook', 'claude-code', NOW))!.token;
});
afterEach(() => vi.useRealTimers());

describe('ingest tokens', () => {
  it('mints aiu_ing_ tokens, stores only the SHA-256 and expires after 90 days', async () => {
    expect(tokenA).toMatch(INGEST_TOKEN_PATTERN);
    const row = await t.db.prepare(`SELECT token_hash, expires_at, scope FROM insight_tokens WHERE learner_id = 'lrn_a'`).first<Record<string, string>>();
    expect(row).toEqual({ token_hash: await hashToken(tokenA), expires_at: '2027-01-24T16:00:00.000Z', scope: 'insights:write' });
    expect(row!.token_hash).toBe(sha(tokenA));
    expect(await count(t.db, `SELECT COUNT(*) AS n FROM insight_tokens WHERE token_hash = ?`, tokenA)).toBe(0);
  });

  it('refuses tokens for guests and deleted learners', async () => {
    await seedMember(t.db, 'lrn_guest', { kind: 'guest' });
    expect(await createToken(t.db, 'lrn_guest', 'x', 'claude-code', NOW)).toBeNull();
    await t.db.prepare(`UPDATE learners SET deleted_at = ? WHERE id = 'lrn_a'`).bind(NOW.toISOString()).run();
    expect(await resolveToken(t.db, tokenA, NOW)).toBeNull();
  });
});

describe('ingest authentication', () => {
  it('answers 401 for a missing, malformed, unknown, revoked or expired token', async () => {
    for (const token of ['', 'nope', `aiu_ing_${'A'.repeat(43)}`]) {
      const res = await turns(turnPayload(), { token: token || undefined });
      expect(res.status).toBe(401);
      expect(await reason(res)).toBe('unauthorized');
    }
    for (const authorization of ['Basic abc', `Bearer ${tokenA} extra`, tokenA]) {
      const res = await turns(turnPayload(), { token: undefined, headers: { authorization } });
      expect(res.status).toBe(401);
      expect(await reason(res)).toBe('unauthorized');
    }
    await t.db.prepare(`UPDATE insight_tokens SET revoked_at = ?`).bind(NOW.toISOString()).run();
    expect((await turns(turnPayload())).status).toBe(401);
    await t.db.prepare(`UPDATE insight_tokens SET revoked_at = NULL, expires_at = ?`).bind(NOW.toISOString()).run();
    expect((await turns(turnPayload())).status).toBe(401);
    expect(await count(t.db, 'SELECT COUNT(*) AS n FROM insight_events')).toBe(0);
  });

  it('rejects any request carrying an Origin header with 403 origin_forbidden', async () => {
    const res = await turns(turnPayload(), { headers: { origin: 'https://unlock.zuey.me' } });
    expect(res.status).toBe(403);
    expect(await reason(res)).toBe('origin_forbidden');
  });

  it('is outside the cookie session middleware', () => {
    expect(learnerPolicy('/api/ingest/v1/turns', 'POST', 'node')).toBe('none');
  });

  it('404s everything while INSIGHTS_MODE is off, and gates internal/pilot by learner', async () => {
    for (const mode of [undefined, 'off', 'bogus']) {
      t.env.INSIGHTS_MODE = mode as never;
      for (const res of [
        await turns(turnPayload()),
        await turns(turnPayload(), { headers: { origin: 'https://evil.example' } }),
        await callRoute(statusRoute, t.env, ingestRequest('/api/ingest/v1/status', { token: tokenA, method: 'GET' })),
      ]) {
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ error: { code: 'not_found', reason: 'feature_off' } });
      }
    }
    t.env.INSIGHTS_MODE = 'internal';
    expect((await turns(turnPayload())).status).toBe(404);
    t.env.INSIGHTS_MODE = 'pilot';
    t.env.INSIGHTS_PILOT_EMAILS = 'LRN_A@example.com';
    expect((await turns(turnPayload())).status).toBe(202);
    t.env.ADMIN_EMAILS = 'lrn_b@example.com';
    t.env.INSIGHTS_MODE = 'internal';
    const tokenB = (await createToken(t.db, 'lrn_b', 'PC', 'claude-code', NOW))!.token;
    expect((await turns(turnPayload(), { token: tokenB })).status).toBe(202);
    expect(await count(t.db, 'SELECT COUNT(*) AS n FROM insight_events')).toBe(2);
  });

  it('binds the learner to the token: the body cannot name one', async () => {
    const res = await turns({ ...turnPayload(), learnerId: 'lrn_b' });
    expect(res.status).toBe(400);
    expect((await turns(turnPayload())).status).toBe(202);
    expect(await count(t.db, `SELECT COUNT(*) AS n FROM insight_events WHERE learner_id = 'lrn_b'`)).toBe(0);
    expect(await count(t.db, `SELECT COUNT(*) AS n FROM insight_events WHERE learner_id = 'lrn_a'`)).toBe(1);
  });

  it('defends against replay: reused key adds no row, sentAt outside ±10 min → 400 clock_skew', async () => {
    expect((await turns(turnPayload())).status).toBe(202);
    expect(await (await turns(turnPayload())).json()).toEqual({ accepted: true, duplicate: true });
    for (const offset of [-11 * 60_000, 11 * 60_000]) {
      const res = await turns(turnPayload({ idempotencyKey: sha(`k${offset}`), sentAt: new Date(NOW.getTime() + offset).toISOString() }));
      expect(res.status).toBe(400);
      expect(await reason(res)).toBe('clock_skew');
    }
    expect((await turns(turnPayload({ idempotencyKey: sha('k9'), sentAt: new Date(NOW.getTime() - 9 * 60_000).toISOString() }))).status).toBe(202);
    expect(await count(t.db, 'SELECT COUNT(*) AS n FROM insight_events')).toBe(2);
  });

  it('rate-limits per learner', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) last = await turns(turnPayload({ idempotencyKey: sha(`rl${i}`) }));
    expect(last!.status).toBe(429);
    expect(await reason(last!)).toBe('rate_limited');
  });

  it('records last use at most once an hour', async () => {
    await turns(turnPayload());
    const first = await t.db.prepare(`SELECT last_used_at FROM insight_tokens`).first('last_used_at');
    expect(first).toBe(NOW.toISOString());
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    await turns(turnPayload({ idempotencyKey: sha('later'), sentAt: new Date().toISOString() }));
    expect(await t.db.prepare(`SELECT last_used_at FROM insight_tokens`).first('last_used_at')).toBe(first);
  });
});

describe('status and self-revoke', () => {
  it('reports the connection state for doctor', async () => {
    const res = await callRoute(statusRoute, t.env, ingestRequest('/api/ingest/v1/status', { token: tokenA, method: 'GET' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      feature: true, consents: { analysis: true }, token: { label: 'MacBook', expiresAt: '2027-01-24T16:00:00.000Z' },
      serverVersion: expect.any(String), latestSkillVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
  });

  it('DELETE /token revokes the calling token only', async () => {
    const other = (await createToken(t.db, 'lrn_a', 'Laptop 2', 'claude-code', NOW))!;
    const res = await callRoute(tokenRoute, t.env, ingestRequest('/api/ingest/v1/token', { token: tokenA, method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect((await turns(turnPayload())).status).toBe(401);
    expect((await listTokens(t.db, 'lrn_a', NOW)).map((d) => d.id)).toEqual([other.id]);
    expect((await turns(turnPayload(), { token: other.token })).status).toBe(202);
  });
});
