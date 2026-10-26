import type { APIRoute } from 'astro';
import { finishSignIn } from '../../../lib/identity/sign-in-flow';
import { SESSION_COOKIE, sessionCookieOptions } from '../../../lib/identity/session-store';

/** GET /auth/zuey/callback — zuey.me redirects here with `code`, `state` and `iss` (or `error`). */
export const GET: APIRoute = async ({ locals, url, cookies }) => {
  let result: Awaited<ReturnType<typeof finishSignIn>>;
  try {
    result = await finishSignIn(locals.runtime.env, {
      requestUrl: url, learner: locals.learner, sessionToken: cookies.get(SESSION_COOKIE)?.value,
    });
  } catch (err) {
    console.error('zuey sign-in callback failed', err instanceof Error ? `${err.name}: ${err.message}` : 'error');
    result = { ok: false, error: 'upstream' };
  }
  // Redirect targets are fixed paths or the validated same-site return_to: the code never stays in history.
  if (!result.ok) {
    return new Response(null, { status: 303, headers: { location: `/auth/error?code=${result.error}`, 'cache-control': 'no-store' } });
  }
  cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions(url));
  return new Response(null, { status: 303, headers: { location: result.returnTo, 'cache-control': 'no-store' } });
};
