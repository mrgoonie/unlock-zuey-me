/**
 * POST /api/v1/insights/reports/delete-all {confirm: "XOA"} → {deleted}. Deletes all of the learner's
 * reports and the turns still waiting in the queue. Same confirm word as /api/v1/me/delete.
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { json, readBody, toErrorResponse } from '../../../../../lib/http/api-response';
import { deleteAllReports } from '../../../../../lib/insights/learner-report-queries';
import { requireInsightsLearner } from './_insights-route-guards';

const deleteAllSchema = z.object({ confirm: z.literal('XOA', { message: 'Hãy gõ XOA để xác nhận' }) });

export const POST: APIRoute = async ({ locals, request }) => {
  const ctx = requireInsightsLearner(locals);
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request, deleteAllSchema);
  if ('response' in body) return body.response;
  try {
    return json({ deleted: await deleteAllReports(ctx.env.DB, ctx.learner.id) });
  } catch (err) {
    return toErrorResponse(err);
  }
};
