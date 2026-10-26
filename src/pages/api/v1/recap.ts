import { apiError, json } from '../../../lib/http/api-response';
import { getRecap } from '../../../lib/learning/service';
import { withLearner } from './_route-helpers';

/** GET /api/v1/recap?period=week|month → Recap */
export const GET = withLearner(async ({ url }, learner, deps) => {
  const period = url.searchParams.get('period') ?? 'week';
  if (period !== 'week' && period !== 'month') return apiError('invalid', 'period phải là week hoặc month.');
  return json(await getRecap(deps, learner, period));
});
