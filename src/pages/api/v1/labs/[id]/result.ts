import { z } from 'zod';
import { json, readBody } from '../../../../../lib/http/api-response';
import { recordLabResult } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

const body = z.object({ result: z.record(z.string(), z.unknown()) });

/** POST /api/v1/labs/:id/result { result } → { labsDone, newBadges } (labs never grant XP). */
export const POST = withLearner(async ({ params, request }, learner, deps) => {
  const parsed = await readBody(request, body);
  if ('response' in parsed) return parsed.response;
  return json(await recordLabResult(deps, learner, String(params.id ?? ''), parsed.data.result));
});
