import { z } from 'zod';
import { json, readBody } from '../../../../../lib/http/api-response';
import { submitEvidence } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

const body = z.object({
  idempotencyKey: z.string().min(8).max(128),
  confidence: z.number().int().min(0).max(100).optional(),
  imageKeys: z.array(z.string().max(200)).max(5).optional(),
});

/**
 * POST /api/v1/runs/:id/submit → SubmitResult. Same key replays (replayed: true, nothing granted twice);
 * a new key on an evaluation_failed run re-evaluates the stored submission.
 */
export const POST = withLearner(async ({ params, request }, learner, deps) => {
  const parsed = await readBody(request, body);
  if ('response' in parsed) return parsed.response;
  return json(await submitEvidence(deps, learner, String(params.id ?? ''), { ...parsed.data, source: 'web' }));
});
