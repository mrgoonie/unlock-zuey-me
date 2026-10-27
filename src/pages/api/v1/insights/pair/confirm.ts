/**
 * POST /api/v1/insights/pair/confirm {userCode, approve, grant?} (web session, members only; a guest gets 403
 * with a sign-in message). Limited per learner. An unknown, expired or already decided code → 404.
 * With approve and `grant`, the consents are granted only after the code is checked to be pending, so a
 * stale or mistyped code grants nothing.
 */
import type { APIRoute } from 'astro';
import { apiError, json, readBody, toErrorResponse } from '../../../../../lib/http/api-response';
import { allowByLimiter, RATE_LIMITED_MESSAGE } from '../../../../../lib/identity/request-rate-limits';
import { setObserverConsent } from '../../../../../lib/privacy/observer-consent';
import { setConsents } from '../../../../../lib/insights/consent-store';
import { confirmPairing, peekPairing } from '../../../../../lib/insights/device-pairing';
import { requireInsightsLearner } from '../../../../../lib/insights/ingest-auth';
import { pairConfirmSchema } from '../../../../../lib/insights/ingest-contract';

export const POST: APIRoute = async ({ locals, request }) => {
  const ctx = requireInsightsLearner(locals, { guestSignIn: true });
  if (ctx instanceof Response) return ctx;
  const { env, learner } = ctx;
  if (!(await allowByLimiter(env, 'RL_WRITE_LEARNER', `pair:${learner.id}`))) return apiError('rate_limited', RATE_LIMITED_MESSAGE);
  const body = await readBody(request, pairConfirmSchema);
  if ('response' in body) return body.response;
  const notFound = () => apiError('not_found', 'Mã ghép nối không đúng hoặc đã hết hạn. Hãy chạy lại lệnh ghép nối trên máy.');
  try {
    const grant = body.data.approve ? body.data.grant : undefined;
    if (grant) {
      if (!(await peekPairing(env.CACHE, body.data.userCode))) return notFound();
      await setConsents(env.DB, learner.id, grant.share ? { analysis: true, shareOperator: true } : { analysis: true });
      if (grant.share) await setObserverConsent(env.DB, learner.id, true);
    }
    const ok = await confirmPairing(env.CACHE, learner.id, body.data.userCode, body.data.approve);
    if (!ok) return notFound();
    return json({ status: body.data.approve ? 'approved' : 'denied' });
  } catch (err) {
    return toErrorResponse(err);
  }
};
