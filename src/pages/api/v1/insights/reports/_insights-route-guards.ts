/**
 * Guards shared by the learner and admin insights routes (the leading underscore keeps this file out of
 * Astro routing). The feature flag is checked first in spirit: a learner for whom insights are not
 * enabled gets the same 404 as an unknown path, so the feature's existence is not revealed.
 */
import { apiError } from '../../../../../lib/http/api-response';
import { insightsEnabledFor } from '../../../../../lib/insights/feature-flags';
import { requireLearner, requireObserverAdmin, type LearnerRouteContext, type RouteLocals } from '../../../../../lib/privacy/learner-route-context';

export const NOT_FOUND_MESSAGE = 'Không tìm thấy.';

/** Signed-in learner with insights enabled: 401 without a session, 404 when the feature is off for them. */
export function requireInsightsLearner(locals: RouteLocals): LearnerRouteContext | Response {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  if (!insightsEnabledFor(ctx.env, ctx.learner)) return apiError('not_found', NOT_FOUND_MESSAGE);
  return ctx;
}

/** Admin with insights enabled: everything else is 404. */
export function requireInsightsAdmin(locals: RouteLocals): LearnerRouteContext | Response {
  const ctx = requireObserverAdmin(locals);
  if (ctx instanceof Response) return ctx;
  if (!insightsEnabledFor(ctx.env, ctx.learner)) return apiError('not_found', NOT_FOUND_MESSAGE);
  return ctx;
}
