import { z } from 'zod';
import { json, readBody } from '../../../lib/http/api-response';
import { recordClientEvent } from '../../../lib/learning/service';
import { withLearner } from './_route-helpers';

const body = z.object({
  name: z.string().max(64),
  missionId: z.string().max(64).optional(),
  runId: z.string().max(80).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

/** POST /api/v1/events { name, missionId?, runId?, props? } → { ok: true } (allow-listed client events only). */
export const POST = withLearner(async ({ request }, learner, deps) => {
  const parsed = await readBody(request, body);
  if ('response' in parsed) return parsed.response;
  await recordClientEvent(deps, learner, parsed.data);
  return json({ ok: true });
});
