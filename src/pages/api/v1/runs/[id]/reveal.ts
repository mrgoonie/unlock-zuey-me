import { z } from 'zod';
import { json, readBody } from '../../../../../lib/http/api-response';
import { revealAnswer } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

const body = z.object({
  stepId: z.string().min(1).max(64),
  /** Quiz question id, or "prediction" for a prediction step. */
  itemId: z.string().min(1).max(64),
}).strict();

/**
 * POST /api/v1/runs/:id/reveal { stepId, itemId } → { run, key: { correct, explanation } }.
 * Records the reveal on the run; the revealed answer is locked (later edits → 403 forbidden).
 * 409 { error, run } when the run changed meanwhile.
 */
export const POST = withLearner(async ({ params, request }, learner, deps) => {
  const parsed = await readBody(request, body);
  if ('response' in parsed) return parsed.response;
  return json(await revealAnswer(deps, learner, String(params.id ?? ''), parsed.data));
});
