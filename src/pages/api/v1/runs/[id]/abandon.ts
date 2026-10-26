import { apiError, json } from '../../../../../lib/http/api-response';
import { allowByLimiter, RATE_LIMITED_MESSAGE } from '../../../../../lib/identity/request-rate-limits';
import { abandonRun } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

/**
 * POST /api/v1/runs/:id/abandon (no body) → { run } with status `abandoned`. Idempotent on an already
 * abandoned run; 409 conflict for a completed run or one still being graded; another learner's run is 404.
 * Same-origin is enforced by the middleware for every state-changing /api/v1 request. Throttled per learner
 * with the row-writing limiter (keyed by its own scope so it does not share a budget with other endpoints).
 */
export const POST = withLearner(async ({ params }, learner, deps) => {
  if (!(await allowByLimiter(deps.env, 'RL_WRITE_LEARNER', `abandon:${learner.id}`))) {
    return apiError('rate_limited', RATE_LIMITED_MESSAGE);
  }
  return json({ run: await abandonRun(deps, learner, String(params.id ?? '')) });
});
