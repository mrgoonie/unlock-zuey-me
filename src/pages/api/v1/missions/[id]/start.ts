import { z } from 'zod';
import { apiError, json } from '../../../../../lib/http/api-response';
import { openMission, startMission } from '../../../../../lib/learning/service';
import { withLearner } from '../../_route-helpers';

const body = z.object({ again: z.boolean().optional() }).strict();

/**
 * POST /api/v1/missions/:id/start { again?: boolean } → { run }. The body is optional.
 * Default: the open run, else the latest completed run (its result is shown read-only), else a new run.
 * `again: true` ("Làm lại"): the open run, else a new run even when the mission was completed.
 */
export const POST = withLearner(async ({ params, request }, learner, deps) => {
  const text = await request.text();
  let again = false;
  if (text.trim()) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return apiError('invalid', 'Body must be JSON');
    }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return apiError('invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    again = parsed.data.again === true;
  }
  const missionId = String(params.id ?? '');
  const run = again ? await startMission(deps, learner, missionId, 'web') : await openMission(deps, learner, missionId, 'web');
  return json({ run });
});
