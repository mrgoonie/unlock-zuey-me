/** POST /api/v1/push/unsubscribe {endpoint}: forgets this device (idempotent). */
import type { APIRoute } from 'astro';
import { json, readBody, toErrorResponse } from '../../../../lib/http/api-response';
import { recordEventSafe } from '../../../../lib/observer/events';
import { requireLearner } from '../../../../lib/privacy/learner-route-context';
import { getPushStatus, removeSubscription, unsubscribeSchema } from '../../../../lib/push/subscription-store';

export const POST: APIRoute = async ({ locals, request }) => {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request, unsubscribeSchema);
  if ('response' in body) return body.response;
  try {
    const removed = await removeSubscription(ctx.env.DB, ctx.learner.id, body.data.endpoint);
    if (removed) await recordEventSafe(ctx.env.DB, { learnerId: ctx.learner.id, name: 'push.unsubscribed', props: { reason: 'user' } });
    return json({ status: await getPushStatus(ctx.env.DB, ctx.learner.id) });
  } catch (err) {
    return toErrorResponse(err);
  }
};
