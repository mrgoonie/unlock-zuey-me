/**
 * GET /api/v1/insights/reports?cursor=&limit=&from=&to=&skill=&mission=&session=
 * → {reports, nextCursor, sessions, queue}. Only the signed-in learner's own reports; filters narrow, never widen.
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { COMPETENCIES } from '../../../../../lib/content/schema';
import { apiError, json, toErrorResponse } from '../../../../../lib/http/api-response';
import { listReports, listSessions, queueState, REPORT_PAGE_MAX, toInstant } from '../../../../../lib/insights/learner-report-queries';
import { requireInsightsLearner } from './_insights-route-guards';

const bound = z.string().max(40).refine((v) => toInstant(v, 'start') !== undefined, 'ngày không hợp lệ');
const querySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(REPORT_PAGE_MAX).optional(),
  from: bound.optional(),
  to: bound.optional(),
  skill: z.enum(COMPETENCIES).optional(),
  mission: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/).optional(),
  session: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const GET: APIRoute = async ({ locals, url }) => {
  const ctx = requireInsightsLearner(locals);
  if (ctx instanceof Response) return ctx;
  // Empty params (e.g. "?skill=") mean "no filter".
  const raw = Object.fromEntries([...url.searchParams.entries()].filter(([, v]) => v !== ''));
  const q = querySchema.safeParse(raw);
  if (!q.success) return apiError('invalid', q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  try {
    const db = ctx.env.DB;
    const id = ctx.learner.id;
    const [page, sessions, queue] = await Promise.all([
      listReports(db, id, {
        cursor: q.data.cursor, limit: q.data.limit, from: q.data.from, to: q.data.to,
        skill: q.data.skill, missionId: q.data.mission, sessionRef: q.data.session,
      }),
      listSessions(db, id),
      queueState(db, id),
    ]);
    return json({ ...page, sessions, queue });
  } catch (err) {
    return toErrorResponse(err);
  }
};
