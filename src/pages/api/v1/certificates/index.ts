import { z } from 'zod';
import { json, readBody } from '../../../../lib/http/api-response';
import { issueCertificate } from '../../../../lib/learning/service';
import { withLearner } from '../_route-helpers';

const body = z.object({ displayName: z.string().max(200) });

/** POST /api/v1/certificates { displayName } → { code, url }; 403 when not eligible yet. */
export const POST = withLearner(async ({ request }, learner, deps) => {
  const parsed = await readBody(request, body);
  if ('response' in parsed) return parsed.response;
  return json(await issueCertificate(deps, learner, parsed.data.displayName));
});
