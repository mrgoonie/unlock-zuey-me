/** GET /api/v1/admin/learners: consenting learners (admin only; 404 for everyone else). */
import type { APIRoute } from 'astro';
import { json, toErrorResponse } from '../../../../../lib/http/api-response';
import { listObservedLearners } from '../../../../../lib/observer/queries';
import { requireObserverAdmin } from '../../../../../lib/privacy/learner-route-context';

export const GET: APIRoute = async ({ locals }) => {
  const ctx = requireObserverAdmin(locals);
  if (ctx instanceof Response) return ctx;
  try {
    return json({ learners: await listObservedLearners(ctx.env.DB) });
  } catch (err) {
    return toErrorResponse(err);
  }
};
