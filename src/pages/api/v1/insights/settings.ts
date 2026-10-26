/**
 * GET /api/v1/insights/settings (web session, member with the feature enabled; 404 otherwise):
 * consents, paired devices, queue state and the report retention, for the Settings panel.
 */
import type { APIRoute } from 'astro';
import { json, toErrorResponse } from '../../../../lib/http/api-response';
import { getConsents } from '../../../../lib/insights/consent-store';
import { insightsRetentionDays } from '../../../../lib/insights/feature-flags';
import { requireInsightsLearner } from '../../../../lib/insights/ingest-auth';
import { listTokens } from '../../../../lib/insights/ingest-tokens';

export const GET: APIRoute = async ({ locals }) => {
  const ctx = requireInsightsLearner(locals);
  if (ctx instanceof Response) return ctx;
  const { env, learner } = ctx;
  try {
    const [consents, devices, queue] = await Promise.all([
      getConsents(env.DB, learner.id),
      listTokens(env.DB, learner.id),
      env.DB.prepare(
        `SELECT COUNT(CASE WHEN status IN ('pending', 'processing') THEN 1 END) AS pending, MAX(received_at) AS last_received_at
           FROM insight_events WHERE learner_id = ?`,
      ).bind(learner.id).first<{ pending: number; last_received_at: string | null }>(),
    ]);
    return json({
      enabled: true,
      member: true,
      consents,
      devices,
      queue: { pending: Number(queue?.pending ?? 0), lastReceivedAt: queue?.last_received_at ?? null },
      retentionDays: insightsRetentionDays(env),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
};
