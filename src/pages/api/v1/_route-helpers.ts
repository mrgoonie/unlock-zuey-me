/**
 * Shared glue for /api/v1 learning routes (the leading underscore keeps this file out of Astro routing).
 * Identity comes only from `locals.learner` (set by the identity middleware); client-supplied learner ids
 * are never read.
 */
import type { APIContext, APIRoute } from 'astro';
import { apiError, json, toErrorResponse } from '../../../lib/http/api-response';
import { RunConflictError } from '../../../lib/learning/errors';
import type { LearningDeps } from '../../../lib/learning/service';
import type { LearnerContext } from '../../../lib/learning/types';

export type LearnerHandler = (ctx: APIContext, learner: LearnerContext, deps: LearningDeps) => Promise<Response>;

export function errorResponse(err: unknown): Response {
  if (err instanceof RunConflictError) return json({ error: { code: 'conflict', message: err.message }, run: err.run }, 409);
  return toErrorResponse(err);
}

/** Wraps a handler: 401 without a learner, deps from the Worker env, LearningError → API error shape. */
export function withLearner(handler: LearnerHandler): APIRoute {
  return async (ctx) => {
    const learner = ctx.locals.learner;
    if (!learner) return apiError('unauthorized', 'Phiên đăng nhập đã hết hạn. Vui lòng tải lại trang.');
    try {
      return await handler(ctx, learner, { env: ctx.locals.runtime.env });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
