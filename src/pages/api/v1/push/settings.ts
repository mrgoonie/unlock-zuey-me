/** GET/PATCH /api/v1/push/settings: reminder status, and {remindTime?, enabled?} for all of the learner's devices. */
import type { APIRoute } from 'astro';
import { apiError, json, readBody, toErrorResponse } from '../../../../lib/http/api-response';
import { requireLearner } from '../../../../lib/privacy/learner-route-context';
import { getPushStatus, settingsSchema, updateSettings } from '../../../../lib/push/subscription-store';

export const GET: APIRoute = async ({ locals }) => {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  try {
    return json({ status: await getPushStatus(ctx.env.DB, ctx.learner.id) });
  } catch (err) {
    return toErrorResponse(err);
  }
};

export const PATCH: APIRoute = async ({ locals, request }) => {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request, settingsSchema);
  if ('response' in body) return body.response;
  try {
    const updated = await updateSettings(ctx.env.DB, ctx.learner.id, body.data);
    if (updated === 0) return apiError('not_found', 'Thiết bị này chưa bật nhắc nhở.');
    return json({ status: await getPushStatus(ctx.env.DB, ctx.learner.id) });
  } catch (err) {
    return toErrorResponse(err);
  }
};
