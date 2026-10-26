/** POST /api/v1/push/subscribe {subscription, remindTime, timezone}: stores this device for daily reminders. */
import type { APIRoute } from 'astro';
import { json, readBody, toErrorResponse } from '../../../../lib/http/api-response';
import { recordEventSafe } from '../../../../lib/observer/events';
import { requireLearner } from '../../../../lib/privacy/learner-route-context';
import { getPushStatus, subscribeSchema, upsertSubscription } from '../../../../lib/push/subscription-store';

export const POST: APIRoute = async ({ locals, request }) => {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request, subscribeSchema);
  if ('response' in body) return body.response;
  try {
    await upsertSubscription(ctx.env.DB, ctx.learner.id, body.data);
    await recordEventSafe(ctx.env.DB, {
      learnerId: ctx.learner.id, name: 'push.subscribed',
      props: { remindTime: body.data.remindTime, timezone: body.data.timezone },
    });
    return json({ status: await getPushStatus(ctx.env.DB, ctx.learner.id) });
  } catch (err) {
    return toErrorResponse(err);
  }
};
