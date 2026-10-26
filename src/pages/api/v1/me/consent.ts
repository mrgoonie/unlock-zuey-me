/** PATCH /api/v1/me/consent {observer: boolean}: grant or revoke observer access to this learner's journey. */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { json, readBody, toErrorResponse } from '../../../../lib/http/api-response';
import { setObserverConsent } from '../../../../lib/privacy/observer-consent';
import { requireLearner } from '../../../../lib/privacy/learner-route-context';

const consentSchema = z.object({ observer: z.boolean() });

export const PATCH: APIRoute = async ({ locals, request }) => {
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request, consentSchema);
  if ('response' in body) return body.response;
  try {
    const observerConsent = await setObserverConsent(ctx.env.DB, ctx.learner.id, body.data.observer);
    return json({ observerConsent });
  } catch (err) {
    return toErrorResponse(err);
  }
};
