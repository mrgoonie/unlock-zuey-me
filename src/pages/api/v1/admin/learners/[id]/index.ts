/**
 * GET /api/v1/admin/learners/:id[?cursor=]: timeline (first page), funnel, hints, scores, calibration,
 * competencies, first win, evidence and coach transcripts. Admin only; not_found without learner consent.
 */
import type { APIRoute } from 'astro';
import { apiError, json, toErrorResponse } from '../../../../../../lib/http/api-response';
import { getLearnerDetail } from '../../../../../../lib/observer/queries';
import { requireObserverAdmin } from '../../../../../../lib/privacy/learner-route-context';

export const GET: APIRoute = async ({ locals, params, url }) => {
  const ctx = requireObserverAdmin(locals);
  if (ctx instanceof Response) return ctx;
  const id = params.id;
  if (!id) return apiError('not_found', 'Không tìm thấy.');
  try {
    const detail = await getLearnerDetail(ctx.env.DB, id, url.searchParams.get('cursor'));
    if (!detail) return apiError('not_found', 'Không tìm thấy.');
    return json(detail);
  } catch (err) {
    return toErrorResponse(err);
  }
};
