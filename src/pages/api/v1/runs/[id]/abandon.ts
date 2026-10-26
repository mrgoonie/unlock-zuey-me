import { json } from '../../../../../lib/http/api-response';
import { abandonRun } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

/**
 * POST /api/v1/runs/:id/abandon (no body) → { run } with status `abandoned`. Idempotent on an already
 * abandoned run; 409 conflict for a completed run or one still being graded; another learner's run is 404.
 * Same-origin and the per-IP / per-learner row-writing throttles are enforced by the middleware
 * (src/lib/identity/request-rate-limits.ts).
 */
export const POST = withLearner(async ({ params }, learner, deps) =>
  json({ run: await abandonRun(deps, learner, String(params.id ?? '')) }));
