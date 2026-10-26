/**
 * PATCH /api/v1/insights/consent {analysis?, shareOperator?, proposals?} → {consents}.
 * Granting shareOperator or proposals needs analysis on (400 otherwise). Turning analysis off turns the
 * other two off and purges queued turns in the same batch; ingest is refused from that moment.
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { json, readBody, toErrorResponse } from '../../../../lib/http/api-response';
import { setConsents } from '../../../../lib/insights/consent-store';
import { requireInsightsLearner } from '../../../../lib/insights/ingest-auth';

const consentPatchSchema = z.object({
  analysis: z.boolean().optional(),
  shareOperator: z.boolean().optional(),
  proposals: z.boolean().optional(),
}).strict().refine((p) => Object.keys(p).length > 0, { message: 'Cần ít nhất một quyền để thay đổi' });

export const PATCH: APIRoute = async ({ locals, request }) => {
  const ctx = requireInsightsLearner(locals);
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request, consentPatchSchema);
  if ('response' in body) return body.response;
  try {
    return json({ consents: await setConsents(ctx.env.DB, ctx.learner.id, body.data) });
  } catch (err) {
    return toErrorResponse(err);
  }
};
