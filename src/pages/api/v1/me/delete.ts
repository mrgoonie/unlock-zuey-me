/** POST /api/v1/me/delete {confirm: "XOA"}: erases all of the learner's data and ends the session. Idempotent. */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { readBody, toErrorResponse } from '../../../../lib/http/api-response';
import { deleteLearnerData, expireAllCookies } from '../../../../lib/privacy/delete-learner-data';
import { requireLearner } from '../../../../lib/privacy/learner-route-context';

const deleteSchema = z.object({ confirm: z.literal('XOA', { message: 'Hãy gõ XOA để xác nhận' }) });

export const POST: APIRoute = async ({ locals, request }) => {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request, deleteSchema);
  if ('response' in body) return body.response;
  try {
    // Loaded lazily: the OAuth provider module only resolves inside the Workers runtime.
    const oauth = ctx.env.OAUTH_KV ? (await import('../../../../lib/mcp/oauth-options')).getOAuthHelpers(ctx.env) : undefined;
    const result = await deleteLearnerData(ctx.env.DB, ctx.env.EVIDENCE, ctx.learner.id, oauth);
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    for (const c of expireAllCookies(request.headers.get('cookie'))) headers.append('set-cookie', c);
    return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers });
  } catch (err) {
    return toErrorResponse(err);
  }
};
