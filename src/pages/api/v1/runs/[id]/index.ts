import { json } from '../../../../../lib/http/api-response';
import { getRunWithEvaluation } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

/**
 * GET /api/v1/runs/:id → { run, mission, evaluation, answerKey }. `mission` is the learner-safe view (no
 * answer keys); `answerKey` holds only revealed items, or every item once the run is completed.
 */
export const GET = withLearner(async ({ params }, learner, deps) =>
  json(await getRunWithEvaluation(deps, learner, String(params.id ?? ''))));
