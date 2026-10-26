/**
 * GET /api/v1/admin/insights/learners/:id/reports → {learner, reports}. Admin with insights enabled, and the
 * learner must have observer_consent = 1, share_operator = 1 and analysis = 1; otherwise 404 (unknown,
 * non-consenting and revoked learners look the same). Each successful call writes an audit row.
 */
import type { APIRoute } from 'astro';
import { apiError, json, toErrorResponse } from '../../../../../../../lib/http/api-response';
import { viewLearnerReportsAsOperator } from '../../../../../../../lib/insights/operator-access-audit';
import { NOT_FOUND_MESSAGE, requireInsightsAdmin } from '../../../../insights/reports/_insights-route-guards';

export const GET: APIRoute = async ({ locals, params }) => {
  const ctx = requireInsightsAdmin(locals);
  if (ctx instanceof Response) return ctx;
  const id = params.id;
  if (!id) return apiError('not_found', NOT_FOUND_MESSAGE);
  try {
    const detail = await viewLearnerReportsAsOperator(ctx.env.DB, id, ctx.learner.id);
    if (!detail) return apiError('not_found', NOT_FOUND_MESSAGE);
    return json(detail);
  } catch (err) {
    return toErrorResponse(err);
  }
};
