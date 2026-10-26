/**
 * GET /api/v1/admin/insights/proposals?status=: proposals with gate reasons, risk, cohort statistics and the
 * issue link, plus the automation settings (admin only; 404 for everyone else and while INSIGHTS_MODE=off).
 */
import type { APIRoute } from 'astro';
import { apiError, json, toErrorResponse } from '../../../../../../lib/http/api-response';
import type { ProposalStatus } from '../../../../../../lib/insights/insight-types';
import { automationSettings } from '../../../../../../lib/insights/proposal-stage';
import { listProposalSummaries, PROPOSAL_STATUSES } from '../../../../../../lib/insights/proposal-store';
import { requireInsightsAdmin } from './_insights-admin-gate';

export const GET: APIRoute = async ({ locals, url }) => {
  const ctx = requireInsightsAdmin(locals);
  if (ctx instanceof Response) return ctx;
  const raw = url.searchParams.get('status');
  if (raw !== null && raw !== '' && !PROPOSAL_STATUSES.includes(raw as ProposalStatus)) {
    return apiError('invalid', 'Trạng thái không hợp lệ.');
  }
  try {
    const now = new Date();
    const [proposals, settings] = await Promise.all([
      listProposalSummaries(ctx.env.DB, raw ? (raw as ProposalStatus) : null, now),
      automationSettings(ctx.env, now),
    ]);
    return json({ proposals, settings });
  } catch (err) {
    return toErrorResponse(err);
  }
};
