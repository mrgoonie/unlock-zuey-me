/** GET /api/v1/me/export: JSON attachment with all of the learner's data. */
import type { APIRoute } from 'astro';
import { toErrorResponse } from '../../../../lib/http/api-response';
import { exportLearnerData } from '../../../../lib/privacy/export-learner-data';
import { requireLearner } from '../../../../lib/privacy/learner-route-context';

export const GET: APIRoute = async ({ locals }) => {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  try {
    const data = await exportLearnerData(ctx.env.DB, ctx.env.EVIDENCE, ctx.learner.id);
    const day = data.exportedAt.slice(0, 10);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="ai-unlocked-du-lieu-${day}.json"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
};
