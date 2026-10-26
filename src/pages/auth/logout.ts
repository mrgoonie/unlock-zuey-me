import type { APIRoute } from 'astro';
import { isSameOriginRequest } from '../../lib/identity/request-policy';
import { SESSION_COOKIE, sessionDeleteByToken } from '../../lib/identity/session-store';

/** POST /auth/logout — ends this browser's session. A new guest is created on the next learner page. */
export const POST: APIRoute = async ({ locals, request, cookies }) => {
  const env = locals.runtime.env;
  if (!isSameOriginRequest(request, env.PUBLIC_SITE_URL)) return new Response('Forbidden', { status: 403 });
  const stmt = await sessionDeleteByToken(env.DB, cookies.get(SESSION_COOKIE)?.value);
  if (stmt) await stmt.run();
  cookies.delete(SESSION_COOKIE, { path: '/' });
  return new Response(null, { status: 303, headers: { location: '/', 'cache-control': 'no-store' } });
};

export const GET: APIRoute = () => new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
