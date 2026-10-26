/**
 * Guards for the learner report routes and the admin insights routes (the leading underscore keeps this file
 * out of Astro routing). The learner gate is the shared web-session gate from ingest-auth.ts; the admin gate
 * adds the feature flag on top of the observer admin check. Everything that fails is the same 404 as an
 * unknown path, so the feature's existence is not revealed.
 */
import { apiError } from '../../../../../lib/http/api-response';
import { FEATURE_OFF_MESSAGE, requireInsightsLearner } from '../../../../../lib/insights/ingest-auth';
import { insightsEnabledFor } from '../../../../../lib/insights/feature-flags';
import { requireObserverAdmin, type LearnerRouteContext, type RouteLocals } from '../../../../../lib/privacy/learner-route-context';

export { requireInsightsLearner };
export const NOT_FOUND_MESSAGE = FEATURE_OFF_MESSAGE;

/** Admin with insights enabled: everything else is 404. */
export function requireInsightsAdmin(locals: RouteLocals): LearnerRouteContext | Response {
  const ctx = requireObserverAdmin(locals);
  if (ctx instanceof Response) return ctx;
  if (!insightsEnabledFor(ctx.env, ctx.learner)) return apiError('not_found', NOT_FOUND_MESSAGE);
  return ctx;
}
