import { z } from 'zod';
import { json, readBody } from '../../../../../lib/http/api-response';
import { saveAnswers } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

// Per-field types and limits are validated against the mission step in answers-validation.ts.
const body = z.object({
  stepId: z.string().min(1).max(64),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.number()])),
  currentStep: z.string().min(1).max(64).optional(),
  rev: z.number().int().min(0),
});

/** PATCH /api/v1/runs/:id/answers → { run }; 409 { error, run } when rev is stale. */
export const PATCH = withLearner(async ({ params, request }, learner, deps) => {
  const parsed = await readBody(request, body);
  if ('response' in parsed) return parsed.response;
  return json({ run: await saveAnswers(deps, learner, String(params.id ?? ''), parsed.data) });
});
