import { json } from '../../../../lib/http/api-response';
import { listMissions } from '../../../../lib/learning/service';
import { withLearner } from '../_route-helpers';

/** GET /api/v1/missions → { missions: MissionListItem[] } */
export const GET = withLearner(async (_ctx, learner, deps) => json({ missions: await listMissions(deps, learner) }));
