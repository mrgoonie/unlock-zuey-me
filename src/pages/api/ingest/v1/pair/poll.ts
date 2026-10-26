/**
 * POST /api/ingest/v1/pair/poll {deviceCode} (no auth, IP-limited, at most one poll per 4 s per device code):
 * 428 {status:'pending'} · 200 {token, expiresAt} exactly once · 410 {status:'expired'|'denied'} · 429 slow_down.
 */
import type { APIRoute } from 'astro';
import { json, toErrorResponse } from '../../../../../lib/http/api-response';
import { PAIR_BODY_MAX_BYTES, pollPairing } from '../../../../../lib/insights/device-pairing';
import { guardIngestRequest } from '../../../../../lib/insights/ingest-auth';
import { ingestError, pairPollSchema, type PairPollResponse } from '../../../../../lib/insights/ingest-contract';
import { readIngestJson } from '../../../../../lib/insights/ingest-service';

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  try {
    const blocked = await guardIngestRequest(request, env, 'pair');
    if (blocked) return blocked;
    const body = await readIngestJson(request, pairPollSchema, PAIR_BODY_MAX_BYTES);
    if ('response' in body) return body.response;
    const outcome = await pollPairing(env.CACHE, env.DB, body.data.deviceCode);
    switch (outcome.kind) {
      case 'slow_down':
        return ingestError('slow_down', 'Bạn đang hỏi quá nhanh. Hãy đợi ít nhất 5 giây giữa hai lần.');
      case 'pending':
        return json({ status: 'pending' } satisfies PairPollResponse, 428);
      case 'expired':
      case 'denied':
        return json({ status: outcome.kind } satisfies PairPollResponse, 410);
      case 'token':
        return json({ token: outcome.token, expiresAt: outcome.expiresAt } satisfies PairPollResponse);
    }
  } catch (err) {
    return toErrorResponse(err);
  }
};
