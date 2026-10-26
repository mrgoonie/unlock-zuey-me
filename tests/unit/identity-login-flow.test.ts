/** Sign in with zuey.me: return_to validation, state/PKCE storage, callback checks, discovery hardening. */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { consumeLoginRequest, createLoginRequest, validateReturnTo } from '../../src/lib/identity/login-requests';
import { finishSignIn, startSignIn } from '../../src/lib/identity/sign-in-flow';
import { clearZueyDiscoveryCache, endpointsFromMetadata } from '../../src/lib/identity/zuey-discovery';

const ISSUER = 'https://zuey.me';
const metadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  userinfo_endpoint: `${ISSUER}/oauth/userinfo`,
  authorization_response_iss_parameter_supported: true,
};

describe('validateReturnTo', () => {
  it.each([
    ['/missions?x=1#a', '/missions?x=1#a'],
    ['/authorize?client_id=https%3A%2F%2Fc.example', '/authorize?client_id=https%3A%2F%2Fc.example'],
    [null, '/home'],
    ['https://evil.example/x', '/home'],
    ['//evil.example', '/home'],
    ['//evil.com', '/home'],
    ['/.//evil.com', '/home'],
    ['/\\evil.com', '/home'],
    ['https://evil.com', '/home'],
    ['/home', '/home'],
    ['/missions/x?y=1', '/missions/x?y=1'],
    ['/\\evil.example', '/home'],
    ['javascript:alert(1)', '/home'],
    ['/ok\nSet-Cookie: x', '/home'],
    ['/auth/zuey/login', '/home'],
    ['missions', '/home'],
    [`/${'a'.repeat(5000)}`, '/home'],
  ])('%s → %s', (input, expected) => {
    expect(validateReturnTo(input)).toBe(expected);
  });
});

describe('login requests', () => {
  it('store an S256 PKCE verifier, are single use and expire after 10 minutes', async () => {
    const db = createTestD1();
    const now = new Date('2026-10-20T10:00:00Z');
    const req = await createLoginRequest(db, { learnerId: 'lrn_g', returnTo: '/missions', now });
    expect(req.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(req.codeChallenge).toBe(createHash('sha256').update(req.codeVerifier).digest('base64url'));

    const first = await consumeLoginRequest(db, req.state, now);
    expect(first).toMatchObject({ ok: true, request: { learnerId: 'lrn_g', returnTo: '/missions' } });
    expect(await consumeLoginRequest(db, req.state, now)).toEqual({ ok: false, reason: 'invalid_state' });

    const late = await createLoginRequest(db, { learnerId: 'lrn_g', returnTo: '/home', now });
    expect(await consumeLoginRequest(db, late.state, new Date(now.getTime() + 10 * 60 * 1000 + 1))).toEqual({ ok: false, reason: 'expired' });
    expect(await consumeLoginRequest(db, null, now)).toEqual({ ok: false, reason: 'invalid_state' });
  });
});

describe('discovery', () => {
  it('rejects metadata for another issuer or with off-origin endpoints', () => {
    expect(endpointsFromMetadata(ISSUER, { ...metadata, issuer: 'https://evil.example' })).toBeNull();
    expect(endpointsFromMetadata(ISSUER, { ...metadata, token_endpoint: 'https://evil.example/token' })).toBeNull();
    expect(endpointsFromMetadata(ISSUER, metadata)?.issParameterRequired).toBe(true);
  });
});

describe('sign-in flow', () => {
  let db: D1Database;
  let env: Pick<Env, 'DB' | 'CACHE' | 'PUBLIC_SITE_URL' | 'ZUEY_ISSUER'>;
  const guest = { id: 'lrn_g', kind: 'guest' as const };
  let userinfoBody: Record<string, unknown>;
  const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/.well-known/oauth-authorization-server')) return Response.json(metadata);
    if (input === metadata.token_endpoint) {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('code') !== 'good-code' || !body.get('code_verifier')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'at-123', token_type: 'Bearer' });
    }
    if (input === metadata.userinfo_endpoint) return Response.json(userinfoBody);
    return new Response('not found', { status: 404 });
  });

  beforeEach(async () => {
    clearZueyDiscoveryCache();
    fetchFn.mockClear();
    userinfoBody = { sub: 'zuey-1', email: 'Duy@Example.com', email_verified: true, name: 'Duy' };
    db = createTestD1();
    const ts = new Date().toISOString();
    await db.prepare(`INSERT INTO learners (id, kind, created_at, updated_at) VALUES ('lrn_g', 'guest', ?, ?)`).bind(ts, ts).run();
    env = { DB: db, CACHE: {} as KVNamespace, PUBLIC_SITE_URL: 'https://unlock.zuey.me', ZUEY_ISSUER: ISSUER };
  });

  async function start(returnTo = '/missions') {
    const r = await startSignIn(env, { requestUrl: new URL('https://unlock.zuey.me/auth/zuey/login'), learner: guest, returnTo, fetchFn });
    if (!r.ok) throw new Error(r.error);
    return new URL(r.location);
  }

  const callback = (params: Record<string, string>, learner: typeof guest | null = guest) =>
    finishSignIn(env, {
      requestUrl: new URL(`https://unlock.zuey.me/auth/zuey/callback?${new URLSearchParams(params)}`),
      learner, sessionToken: undefined, fetchFn,
    });

  it('builds the authorize URL with the CIMD client, explicit identity scopes and S256 PKCE', async () => {
    const url = await start();
    expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
    expect(url.searchParams.get('client_id')).toBe('https://unlock.zuey.me/oauth/zuey-client.json');
    expect(url.searchParams.get('redirect_uri')).toBe('https://unlock.zuey.me/auth/zuey/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBeNull();
  });

  it('completes: verified email stored, member upserted, return_to honoured', async () => {
    const url = await start('/progress');
    const result = await callback({ code: 'good-code', state: url.searchParams.get('state')!, iss: ISSUER });
    expect(result).toMatchObject({ ok: true, returnTo: '/progress', memberId: 'lrn_g' });
    expect(await db.prepare(`SELECT kind, email FROM learners WHERE id = 'lrn_g'`).first()).toEqual({ kind: 'member', email: 'duy@example.com' });
    const tokenCall = fetchFn.mock.calls.find(([u]) => u === metadata.token_endpoint)!;
    const sent = new URLSearchParams(String(tokenCall[1]?.body));
    expect(sent.get('client_id')).toBe('https://unlock.zuey.me/oauth/zuey-client.json');
    expect(await db.prepare(`SELECT name FROM events WHERE learner_id = 'lrn_g'`).first('name')).toBe('auth.signed_in');
  });

  it('rejects a callback from another browser (login CSRF) and consumes the state', async () => {
    const url = await start();
    const state = url.searchParams.get('state')!;
    expect(await callback({ code: 'good-code', state, iss: ISSUER }, { id: 'lrn_attacker', kind: 'guest' })).toEqual({ ok: false, error: 'wrong_browser' });
    expect(await callback({ code: 'good-code', state, iss: ISSUER })).toEqual({ ok: false, error: 'invalid_state' });
  });

  it('rejects a wrong or missing iss when the issuer advertises RFC 9207', async () => {
    const a = await start();
    expect(await callback({ code: 'good-code', state: a.searchParams.get('state')!, iss: 'https://evil.example' })).toEqual({ ok: false, error: 'issuer_mismatch' });
    const b = await start();
    expect(await callback({ code: 'good-code', state: b.searchParams.get('state')!})).toEqual({ ok: false, error: 'issuer_mismatch' });
    expect(fetchFn.mock.calls.some(([u]) => u === metadata.token_endpoint)).toBe(false);
  });

  it('maps provider errors and failed exchanges to error codes without leaking tokens', async () => {
    const a = await start();
    expect(await callback({ error: 'access_denied', state: a.searchParams.get('state')! })).toEqual({ ok: false, error: 'cancelled' });
    const b = await start();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await callback({ code: 'bad-code', state: b.searchParams.get('state')!, iss: ISSUER })).toEqual({ ok: false, error: 'upstream' });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('bad-code');
    spy.mockRestore();
  });

  it('does not store an unverified email', async () => {
    userinfoBody = { sub: 'zuey-1', email: 'x@example.com', email_verified: false };
    const url = await start();
    await callback({ code: 'good-code', state: url.searchParams.get('state')!, iss: ISSUER });
    expect(await db.prepare(`SELECT email FROM learners WHERE id = 'lrn_g'`).first('email')).toBeNull();
  });
});
