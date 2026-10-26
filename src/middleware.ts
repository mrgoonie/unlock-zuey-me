/**
 * Request middleware (identity module):
 * 1. Rejects cross-origin state-changing /api/v1 requests (403) before any work happens.
 * 2. Resolves the `uz_session` cookie into `locals.learner`, lazily creating a guest learner + session for
 *    learner pages and /api/v1 (see learnerPolicy for the exempt paths and bots).
 * 3. Adds security headers (CSP etc.) to HTML responses.
 * /mcp and the OAuth endpoints never reach Astro: src/worker.ts routes them through the OAuth provider.
 */
import { defineMiddleware } from 'astro:middleware';
import { apiError } from './lib/http/api-response';
import { resolveRequestLearner } from './lib/identity/request-learner';
import {
  isApiV1, isSameOriginRequest, isStateChangingMethod, learnerPolicy, withSecurityHeaders,
} from './lib/identity/request-policy';
import { SESSION_COOKIE, sessionCookieOptions } from './lib/identity/session-store';

export const onRequest = defineMiddleware(async (context, next) => {
  const csp = !import.meta.env.DEV; // Vite's dev client needs inline/eval freedoms the production CSP forbids.
  const env = context.locals.runtime?.env;
  if (context.isPrerendered || !env) return withSecurityHeaders(await next(), { csp });

  const { request, url } = context;
  const api = isApiV1(url.pathname);
  if (api && isStateChangingMethod(request.method) && !isSameOriginRequest(request, env.PUBLIC_SITE_URL)) {
    return apiError('forbidden', 'Yêu cầu bị chặn vì không đến từ trang AI Unlocked.');
  }

  const policy = learnerPolicy(url.pathname, request.method, request.headers.get('user-agent'));
  try {
    const result = await resolveRequestLearner(env, {
      token: context.cookies.get(SESSION_COOKIE)?.value, policy, now: new Date(),
    });
    if (result.learner) context.locals.learner = result.learner;
    if (result.setCookieToken) context.cookies.set(SESSION_COOKIE, result.setCookieToken, sessionCookieOptions(url));
    else if (result.clearCookie) context.cookies.delete(SESSION_COOKIE, { path: '/' });
  } catch (err) {
    console.error('session resolution failed', err instanceof Error ? `${err.name}: ${err.message}` : 'error');
    if (api) return apiError('unavailable', 'Hệ thống đang bận, bạn thử lại sau ít phút nhé.');
    throw err;
  }

  // The contract guarantees a learner on every /api/v1 route; only bots (no guest is created) end up here.
  if (api && !context.locals.learner) return apiError('unauthorized', 'Cần mở AI Unlocked trên trình duyệt để bắt đầu phiên học.');

  return withSecurityHeaders(await next(), { csp });
});
