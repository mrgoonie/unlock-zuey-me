/**
 * Request middleware (identity module):
 * 1. Rejects cross-origin state-changing /api/v1 requests (403) before any work happens.
 * 2. Resolves the `uz_session` cookie into `locals.learner`, lazily creating a guest learner + session for
 *    learner pages and /api/v1 (see learnerPolicy for the exempt paths and bots).
 *    Guest creation is throttled per IP; AI, upload and row-writing endpoints are throttled per IP (before
 *    any guest is created) and, for the row-writing ones, per learner (src/lib/identity/request-rate-limits.ts).
 * 3. Adds security headers (CSP etc.) to HTML responses.
 * /mcp and the OAuth endpoints never reach Astro: src/worker.ts routes them through the OAuth provider.
 */
import { defineMiddleware } from 'astro:middleware';
import { apiError } from './lib/http/api-response';
import { resolveRequestLearner } from './lib/identity/request-learner';
import {
  allowByLimiter, clientIpKey, GUEST_LIMITED_MESSAGE, RATE_LIMITED_MESSAGE, throttledRoute,
} from './lib/identity/request-rate-limits';
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

  const ip = clientIpKey(request);
  const throttle = api ? throttledRoute(url.pathname, request.method) : null;
  if (throttle && !(await allowByLimiter(env, throttle.ipLimiter, `${throttle.scope}:${ip}`))) {
    return apiError('rate_limited', RATE_LIMITED_MESSAGE);
  }

  const policy = learnerPolicy(url.pathname, request.method, request.headers.get('user-agent'));
  try {
    const result = await resolveRequestLearner(env, {
      token: context.cookies.get(SESSION_COOKIE)?.value, policy, now: new Date(),
      allowGuestCreation: () => allowByLimiter(env, 'RL_GUEST_IP', ip),
    });
    // Pages render without a learner (like for bots); the API needs one, so it answers 429.
    if (result.guestThrottled && api) return apiError('rate_limited', GUEST_LIMITED_MESSAGE);
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

  const learnerId = context.locals.learner?.id;
  if (throttle?.learnerLimiter && learnerId && !(await allowByLimiter(env, throttle.learnerLimiter, `${throttle.scope}:${learnerId}`))) {
    return apiError('rate_limited', RATE_LIMITED_MESSAGE);
  }

  return withSecurityHeaders(await next(), { csp });
});
