/**
 * GET/PATCH /api/v1/admin/insights/settings: GitHub automation state for the operator. Reports whether the
 * token is configured as a boolean only (the token itself never leaves the publisher). PATCH toggles
 * `safe_auto_implement` and requires the typed confirmation "BAT". Admin only; 404 otherwise and while
 * INSIGHTS_MODE=off.
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { json, readBody, toErrorResponse } from '../../../../../lib/http/api-response';
import { setSafeAutoImplement } from '../../../../../lib/insights/operator-settings';
import { automationSettings } from '../../../../../lib/insights/proposal-stage';
import { requireInsightsAdmin } from './proposals/_insights-admin-gate';

const patchSchema = z.object({ safeAutoImplement: z.boolean(), confirm: z.literal('BAT') }).strict();

export const GET: APIRoute = async ({ locals }) => {
  const ctx = requireInsightsAdmin(locals);
  if (ctx instanceof Response) return ctx;
  try {
    return json(await automationSettings(ctx.env, new Date()));
  } catch (err) {
    return toErrorResponse(err);
  }
};

export const PATCH: APIRoute = async ({ locals, request }) => {
  const ctx = requireInsightsAdmin(locals);
  if (ctx instanceof Response) return ctx;
  const body = await readBody(request, patchSchema);
  if ('response' in body) return body.response;
  try {
    const now = new Date();
    await setSafeAutoImplement(ctx.env.DB, body.data.safeAutoImplement, ctx.learner.id, now);
    return json(await automationSettings(ctx.env, now));
  } catch (err) {
    return toErrorResponse(err);
  }
};
