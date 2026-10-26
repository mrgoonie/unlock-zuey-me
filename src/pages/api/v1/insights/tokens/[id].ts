/** DELETE /api/v1/insights/tokens/:id (web session): revoke one of the learner's own devices; anything else → 404. */
import type { APIRoute } from 'astro';
import { apiError, json, toErrorResponse } from '../../../../../lib/http/api-response';
import { requireInsightsLearner } from '../../../../../lib/insights/ingest-auth';
import { revokeToken } from '../../../../../lib/insights/ingest-tokens';

export const DELETE: APIRoute = async ({ locals, params }) => {
  const ctx = requireInsightsLearner(locals);
  if (ctx instanceof Response) return ctx;
  const id = params.id ?? '';
  try {
    if (!/^itk_[a-z0-9]{1,64}$/.test(id) || !(await revokeToken(ctx.env.DB, ctx.learner.id, id))) {
      return apiError('not_found', 'Không tìm thấy thiết bị.');
    }
    return json({ revoked: true });
  } catch (err) {
    return toErrorResponse(err);
  }
};
