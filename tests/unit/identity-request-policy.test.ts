/** Middleware request policies: CSRF origin rule, session policy per path, security headers, CIMD document. */
import { describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../helpers/d1-sqlite';
import { buildClientMetadataDocument } from '../../src/lib/identity/zuey-client-metadata';
import {
  CONTENT_SECURITY_POLICY, isSameOriginRequest, learnerPolicy, withSecurityHeaders,
} from '../../src/lib/identity/request-policy';

vi.mock('astro:middleware', () => ({ defineMiddleware: <T>(fn: T) => fn }));

const SITE = 'https://unlock.zuey.me';
const req = (headers: Record<string, string>, url = `${SITE}/api/v1/runs`) => new Request(url, { method: 'POST', headers });

describe('isSameOriginRequest', () => {
  it('accepts the site origin, the request origin, and header-less non-browser clients', () => {
    expect(isSameOriginRequest(req({ origin: SITE }), SITE)).toBe(true);
    expect(isSameOriginRequest(req({ origin: 'http://localhost:4321' }, 'http://localhost:4321/api/v1/x'), SITE)).toBe(true);
    expect(isSameOriginRequest(req({}), SITE)).toBe(true);
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }), SITE)).toBe(true);
  });

  it('rejects foreign, null, look-alike origins and cross-site fetch metadata', () => {
    for (const origin of ['https://evil.example', 'null', 'https://unlock.zuey.me.evil.example', 'http://unlock.zuey.me']) {
      expect(isSameOriginRequest(req({ origin }), SITE), origin).toBe(false);
    }
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'cross-site' }), SITE)).toBe(false);
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-site' }), SITE)).toBe(false);
  });
});

describe('learnerPolicy', () => {
  const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36';
  it.each([
    ['/', 'GET', chrome, 'read'],
    ['/home', 'GET', chrome, 'create'],
    ['/missions/plan-weekend', 'GET', 'Googlebot/2.1', 'read'],
    ['/api/v1/runs', 'POST', chrome, 'create'],
    ['/api/v1/runs', 'POST', 'curl/8.0', 'read'],
    ['/api/v1/runs', 'POST', null, 'read'],
    ['/api/health', 'GET', chrome, 'none'],
    ['/mcp', 'POST', chrome, 'none'],
    ['/.well-known/oauth-protected-resource/mcp', 'GET', chrome, 'none'],
    ['/oauth/zuey-client.json', 'GET', chrome, 'none'],
    ['/_astro/app.js', 'GET', chrome, 'none'],
    ['/sw.js', 'GET', chrome, 'none'],
    ['/certificates/ABC', 'GET', chrome, 'read'],
    ['/authorize', 'GET', chrome, 'read'],
    ['/auth/zuey/callback', 'GET', chrome, 'read'],
    ['/auth/zuey/login', 'GET', chrome, 'create'],
    ['/home', 'PUT', chrome, 'read'],
  ])('%s %s (%s) → %s', (path, method, ua, expected) => {
    expect(learnerPolicy(path, method, ua)).toBe(expected);
  });
});

describe('withSecurityHeaders', () => {
  it('adds CSP and frame protection to HTML only, keeps a page CSP, and copes with immutable headers', () => {
    const html = withSecurityHeaders(new Response('<p>', { headers: { 'content-type': 'text/html; charset=utf-8' } }), { csp: true });
    expect(html.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(html.headers.get('x-frame-options')).toBe('DENY');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');

    const json = withSecurityHeaders(Response.json({}), { csp: true });
    expect(json.headers.get('content-security-policy')).toBeNull();
    expect(json.headers.get('x-content-type-options')).toBe('nosniff');

    const redirect = withSecurityHeaders(Response.redirect(`${SITE}/home`, 302), { csp: true });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');

    const page = new Response('<p>', { headers: { 'content-type': 'text/html', 'content-security-policy': "form-action 'self'" } });
    expect(withSecurityHeaders(page, { csp: true }).headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });
});

describe('middleware', () => {
  async function runMiddleware(request: Request) {
    const { onRequest } = await import('../../src/middleware');
    const env = { DB: createTestD1(), ADMIN_EMAILS: '', PUBLIC_SITE_URL: SITE } as unknown as Env;
    const set = vi.fn();
    const next = vi.fn(async () => Response.json({ ok: true }));
    const context = {
      request, url: new URL(request.url), isPrerendered: false, locals: { runtime: { env } } as App.Locals,
      cookies: { get: () => undefined, set, delete: vi.fn() },
    };
    const res = await (onRequest as unknown as (c: typeof context, n: typeof next) => Promise<Response>)(context, next);
    return { res, next, set, context, env };
  }

  it('blocks a cross-origin POST to /api/v1 before creating any session', async () => {
    const { res, next, set, env } = await runMiddleware(req({ origin: 'https://evil.example', 'user-agent': 'Mozilla/5.0' }));
    expect(res.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM learners').first('n')).toBe(0);
  });

  it('creates a guest for a same-origin browser POST and sets the session cookie', async () => {
    const { res, next, set, context } = await runMiddleware(req({ origin: SITE, 'user-agent': 'Mozilla/5.0' }));
    expect(res.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
    expect(context.locals.learner?.kind).toBe('guest');
    expect(set).toHaveBeenCalledWith('uz_session', expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expect.objectContaining({ httpOnly: true }));
  });

  it('answers 401 on /api/v1 for clients that get no guest (bots)', async () => {
    const { res, next } = await runMiddleware(new Request(`${SITE}/api/v1/progress`, { headers: { 'user-agent': 'curl/8.0' } }));
    expect(res.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('Client ID Metadata Document', () => {
  it('names our client_id URL and only the production callback', () => {
    expect(buildClientMetadataDocument('https://unlock.zuey.me/')).toEqual({
      client_id: 'https://unlock.zuey.me/oauth/zuey-client.json',
      client_name: 'AI Unlocked',
      client_uri: 'https://unlock.zuey.me',
      logo_uri: 'https://unlock.zuey.me/icons/icon.svg',
      redirect_uris: ['https://unlock.zuey.me/auth/zuey/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid profile email',
    });
  });
});
