/**
 * POST /api/ingest/v1/pair/start {label, adapter} (no auth, IP-limited): starts device pairing and returns
 * the device code (kept by the CLI) and the user code the learner approves at /insights/pair.
 */
import type { APIRoute } from 'astro';
import { json, toErrorResponse } from '../../../../../lib/http/api-response';
import { PAIR_BODY_MAX_BYTES, siteOrigin, startPairing } from '../../../../../lib/insights/device-pairing';
import { guardIngestRequest } from '../../../../../lib/insights/ingest-auth';
import { pairStartSchema } from '../../../../../lib/insights/ingest-contract';
import { readIngestJson } from '../../../../../lib/insights/ingest-service';

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  try {
    const blocked = await guardIngestRequest(request, env, 'pair');
    if (blocked) return blocked;
    const body = await readIngestJson(request, pairStartSchema, PAIR_BODY_MAX_BYTES);
    if ('response' in body) return body.response;
    return json(await startPairing(env.CACHE, body.data, siteOrigin(env, request)));
  } catch (err) {
    return toErrorResponse(err);
  }
};
