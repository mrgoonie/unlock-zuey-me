import { json } from '../../../../../lib/http/api-response';
import { recordConceptView } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

/** POST /api/v1/concepts/:id/view → { ok: true } (first view is recorded once). */
export const POST = withLearner(async ({ params }, learner, deps) => {
  await recordConceptView(deps, learner, String(params.id ?? ''));
  return json({ ok: true });
});
