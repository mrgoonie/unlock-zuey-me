/** DELETE /api/ingest/v1/token (bearer device token): the device revokes its own token (`uninstall --purge`). */
import type { APIRoute } from 'astro';
import { json, toErrorResponse } from '../../../../lib/http/api-response';
import { authenticateIngest } from '../../../../lib/insights/ingest-auth';
import { revokeToken } from '../../../../lib/insights/ingest-tokens';

export const DELETE: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  try {
    const auth = await authenticateIngest(request, env);
    if (!auth.ok) return auth.response;
    await revokeToken(env.DB, auth.value.learner.id, auth.value.tokenId);
    return json({ revoked: true });
  } catch (err) {
    return toErrorResponse(err);
  }
};
