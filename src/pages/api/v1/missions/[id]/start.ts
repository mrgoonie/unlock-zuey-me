import { json } from '../../../../../lib/http/api-response';
import { startMission } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

/** POST /api/v1/missions/:id/start → { run } (resumes the open run if any). */
export const POST = withLearner(async ({ params }, learner, deps) =>
  json({ run: await startMission(deps, learner, String(params.id ?? ''), 'web') }));
