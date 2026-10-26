/** GET /api/ingest/v1/status (bearer device token): what `ai-unlocked doctor` shows about the connection. */
import type { APIRoute } from 'astro';
import { json, toErrorResponse } from '../../../../lib/http/api-response';
import { getConsents } from '../../../../lib/insights/consent-store';
import { authenticateIngest } from '../../../../lib/insights/ingest-auth';
import type { IngestStatusResponse } from '../../../../lib/insights/ingest-contract';
import { INGEST_SERVER_VERSION, LATEST_SKILL_VERSION } from '../../../../lib/insights/ingest-service';

export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  try {
    const auth = await authenticateIngest(request, env);
    if (!auth.ok) return auth.response;
    const consents = await getConsents(env.DB, auth.value.learner.id);
    const body: IngestStatusResponse = {
      feature: true,
      consents: { analysis: consents.analysis },
      token: { label: auth.value.label, expiresAt: auth.value.expiresAt },
      serverVersion: INGEST_SERVER_VERSION,
      latestSkillVersion: LATEST_SKILL_VERSION,
    };
    return json(body);
  } catch (err) {
    return toErrorResponse(err);
  }
};
