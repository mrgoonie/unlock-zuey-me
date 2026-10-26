import type { APIRoute } from 'astro';

/** Liveness + D1 reachability for deploy verification. */
export const GET: APIRoute = async ({ locals }) => {
  const env = locals.runtime.env;
  let db = 'ok';
  try {
    await env.DB.prepare('SELECT 1').first();
  } catch {
    db = 'error';
  }
  return Response.json({ ok: db === 'ok', db }, { status: db === 'ok' ? 200 : 503, headers: { 'cache-control': 'no-store' } });
};
