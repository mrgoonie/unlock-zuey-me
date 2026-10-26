/**
 * GET /api/v1/admin/insights/summary → {health, patterns, signals, sharingLearners}. Admin with insights
 * enabled only (404 otherwise). Aggregates are counts with k ≥ 3; see operator-insight-queries.ts.
 */
import type { APIRoute } from 'astro';
import { json, toErrorResponse } from '../../../../../lib/http/api-response';
import { operatorSummary } from '../../../../../lib/insights/operator-insight-queries';
import { requireInsightsAdmin } from '../../insights/reports/_insights-route-guards';

export const GET: APIRoute = async ({ locals }) => {
  const ctx = requireInsightsAdmin(locals);
  if (ctx instanceof Response) return ctx;
  try {
    return json(await operatorSummary(ctx.env.DB));
  } catch (err) {
    return toErrorResponse(err);
  }
};
