/**
 * POST /api/ingest/v1/turns (bearer device token): enqueue one redacted turn for ai-tutor.
 * 202 {accepted, duplicate}; errors use the ingest shape {error:{code,message,reason}} (ingest-contract.ts).
 */
import type { APIRoute } from 'astro';
import { toErrorResponse } from '../../../../lib/http/api-response';
import { authenticateIngest } from '../../../../lib/insights/ingest-auth';
import { ingestTurn, readIngestBody } from '../../../../lib/insights/ingest-service';

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const now = new Date();
  try {
    const auth = await authenticateIngest(request, env, now);
    if (!auth.ok) return auth.response;
    const body = await readIngestBody(request);
    if ('response' in body) return body.response;
    return await ingestTurn(env, auth.value, body.text, now);
  } catch (err) {
    return toErrorResponse(err);
  }
};
