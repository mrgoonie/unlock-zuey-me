/**
 * Shared gate of the admin insights proposal/settings routes (the leading underscore keeps Astro from
 * routing this file). Everyone but an admin for whom the insights feature is enabled gets the same 404 as an
 * unknown path, so neither the feature nor the dashboard is revealed; with INSIGHTS_MODE=off that is
 * everyone, admins included.
 */
import { apiError } from '../../../../../../lib/http/api-response';
import { insightsEnabledFor } from '../../../../../../lib/insights/feature-flags';
import { requireObserverAdmin, type LearnerRouteContext, type RouteLocals } from '../../../../../../lib/privacy/learner-route-context';

export function requireInsightsAdmin(locals: RouteLocals): LearnerRouteContext | Response {
  const ctx = requireObserverAdmin(locals);
  if (ctx instanceof Response) return ctx;
  if (!insightsEnabledFor(ctx.env, ctx.learner)) return apiError('not_found', 'Không tìm thấy.');
  return ctx;
}
