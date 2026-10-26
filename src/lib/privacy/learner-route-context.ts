/**
 * Shared guard for the platform module's /api/v1 routes (push, me/consent|export|delete, admin).
 * The identity middleware sets locals.learner for every /api/v1 request; a missing learner means the
 * session could not be established, which is answered with 401.
 */
import { apiError } from '../http/api-response';
import type { LearnerContext } from '../learning/types';

/** The slice of Astro locals these routes read (lets unit tests pass plain objects). */
export interface RouteLocals {
  learner?: LearnerContext;
  runtime: { env: Env };
}

export type LearnerRouteContext = { learner: LearnerContext; env: Env };

export function requireLearner(locals: RouteLocals): LearnerRouteContext | Response {
  if (!locals.learner) return apiError('unauthorized', 'Phiên làm việc đã hết hạn. Hãy tải lại trang.');
  return { learner: locals.learner, env: locals.runtime.env };
}

/**
 * Admin observer gate. Non-admins get the same 404 as an unknown path so the dashboard's existence is not
 * revealed. Consent of the observed learner is enforced separately in src/lib/observer/queries.ts.
 */
export function requireObserverAdmin(locals: RouteLocals): LearnerRouteContext | Response {
  if (!locals.learner?.isAdmin) return apiError('not_found', 'Không tìm thấy.');
  return { learner: locals.learner, env: locals.runtime.env };
}
