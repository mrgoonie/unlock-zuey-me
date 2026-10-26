/** DELETE /api/v1/insights/reports/:id → {ok:true}. Another learner's or an unknown id → 404. */
import type { APIRoute } from 'astro';
import { apiError, json, toErrorResponse } from '../../../../../lib/http/api-response';
import { deleteReport } from '../../../../../lib/insights/learner-report-queries';
import { NOT_FOUND_MESSAGE, requireInsightsLearner } from './_insights-route-guards';

export const DELETE: APIRoute = async ({ locals, params }) => {
  const ctx = requireInsightsLearner(locals);
  if (ctx instanceof Response) return ctx;
  const id = params.id;
  if (!id) return apiError('not_found', NOT_FOUND_MESSAGE);
  try {
    if (!(await deleteReport(ctx.env.DB, ctx.learner.id, id))) return apiError('not_found', NOT_FOUND_MESSAGE);
    return json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
};
