/** POST /api/v1/insights/reports/:id/feedback {useful: boolean} → {ok:true}. Another learner's id → 404. */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { apiError, json, readBody, toErrorResponse } from '../../../../../../lib/http/api-response';
import { setUseful } from '../../../../../../lib/insights/learner-report-queries';
import { NOT_FOUND_MESSAGE, requireInsightsLearner } from '../_insights-route-guards';

const feedbackSchema = z.object({ useful: z.boolean() }).strict();

export const POST: APIRoute = async ({ locals, params, request }) => {
  const ctx = requireInsightsLearner(locals);
  if (ctx instanceof Response) return ctx;
  const id = params.id;
  if (!id) return apiError('not_found', NOT_FOUND_MESSAGE);
  const body = await readBody(request, feedbackSchema);
  if ('response' in body) return body.response;
  try {
    if (!(await setUseful(ctx.env.DB, ctx.learner.id, id, body.data.useful))) return apiError('not_found', NOT_FOUND_MESSAGE);
    return json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
};
