import { z } from 'zod';
import { json, readBody } from '../../../../lib/http/api-response';
import { updateLearnerProfile } from '../../../../lib/learning/service';
import { withLearner } from '../_route-helpers';

// Field-level validation of `profile` lives in learner-profile.ts (strict schema).
const body = z.object({
  profile: z.record(z.string(), z.unknown()).optional(),
  displayName: z.string().optional(),
}).strict();

/** PATCH /api/v1/me/profile { profile?, displayName? } → { learner } */
export const PATCH = withLearner(async ({ request }, learner, deps) => {
  const parsed = await readBody(request, body);
  if ('response' in parsed) return parsed.response;
  return json({ learner: await updateLearnerProfile(deps, learner, parsed.data) });
});
