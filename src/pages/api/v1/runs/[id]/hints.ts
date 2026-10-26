import { z } from 'zod';
import { json, readBody } from '../../../../../lib/http/api-response';
import { requestHint } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

const body = z.object({
  stepId: z.string().min(1).max(64),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});

/** POST /api/v1/runs/:id/hints { stepId, level } → HintResult */
export const POST = withLearner(async ({ params, request }, learner, deps) => {
  const parsed = await readBody(request, body);
  if ('response' in parsed) return parsed.response;
  return json(await requestHint(deps, learner, String(params.id ?? ''), parsed.data.stepId, parsed.data.level));
});
