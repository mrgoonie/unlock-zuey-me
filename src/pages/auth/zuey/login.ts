import type { APIRoute } from 'astro';
import { startSignIn } from '../../../lib/identity/sign-in-flow';

/** GET /auth/zuey/login?return_to=/path — starts Sign in with zuey.me (PKCE + state bound to this browser). */
export const GET: APIRoute = async ({ locals, url, redirect }) => {
  let result: Awaited<ReturnType<typeof startSignIn>>;
  try {
    result = await startSignIn(locals.runtime.env, {
      requestUrl: url, learner: locals.learner, returnTo: url.searchParams.get('return_to'),
    });
  } catch (err) {
    console.error('zuey sign-in start failed', err instanceof Error ? `${err.name}: ${err.message}` : 'error');
    result = { ok: false, error: 'upstream' };
  }
  if (!result.ok) return redirect(`/auth/error?code=${result.error}`, 303);
  return new Response(null, { status: 302, headers: { location: result.location, 'cache-control': 'no-store' } });
};
