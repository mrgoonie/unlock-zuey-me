/** GET /api/v1/admin/learners/:id/events?cursor=&limit=: paginated event timeline (admin only, consent-gated). */
import type { APIRoute } from 'astro';
import { apiError, json, toErrorResponse } from '../../../../../../lib/http/api-response';
import { getTimelinePage } from '../../../../../../lib/observer/queries';
import { requireObserverAdmin } from '../../../../../../lib/privacy/learner-route-context';

export const GET: APIRoute = async ({ locals, params, url }) => {
  const ctx = requireObserverAdmin(locals);
  if (ctx instanceof Response) return ctx;
  if (!params.id) return apiError('not_found', 'Không tìm thấy.');
  const limitRaw = Number(url.searchParams.get('limit') ?? '');
  try {
    const page = await getTimelinePage(ctx.env.DB, params.id, {
      cursor: url.searchParams.get('cursor'),
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });
    if (!page) return apiError('not_found', 'Không tìm thấy.');
    return json(page);
  } catch (err) {
    return toErrorResponse(err);
  }
};
