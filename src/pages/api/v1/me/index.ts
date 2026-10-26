import { json } from '../../../../lib/http/api-response';
import { getProgress } from '../../../../lib/learning/service';
import { withLearner } from '../_route-helpers';

/** GET /api/v1/me → { learner, progress } */
export const GET = withLearner(async (_ctx, learner, deps) => json({ learner, progress: await getProgress(deps, learner) }));
