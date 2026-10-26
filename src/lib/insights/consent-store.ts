/**
 * The three insights consents (insight_consents): `analysis`, `share_operator`, `proposals`. An absent row
 * means all three are off. Separate from learners.observer_consent.
 *
 * Invariants, enforced inside the UPSERT itself so concurrent requests cannot break them:
 * - `share_operator` and `proposals` can only be 1 while `analysis` is 1.
 * - Revoking `analysis` deletes the learner's `pending` and `processing` queue rows in the same D1 batch,
 *   and ingest re-checks consent inside its INSERT (ingest-service.ts), so nothing new lands afterwards.
 */
import { nowIso } from '../db/ids';
import { LearningError } from '../learning/types';
import { recordEventSafe } from '../observer/events';
import { NO_INSIGHT_CONSENTS, type InsightConsentKind, type InsightConsents } from './insight-types';

export interface ConsentPatch {
  analysis?: boolean;
  shareOperator?: boolean;
  proposals?: boolean;
}

interface ConsentRow {
  analysis: number;
  share_operator: number;
  proposals: number;
  analysis_at: string | null;
  share_operator_at: string | null;
  proposals_at: string | null;
  updated_at: string | null;
}

const consentExists = (column: InsightConsentKind) => (alias: string): string =>
  `EXISTS (SELECT 1 FROM insight_consents ic_${column} WHERE ic_${column}.learner_id = ${alias}.learner_id AND ic_${column}.analysis = 1` +
  (column === 'analysis' ? ')' : ` AND ic_${column}.${column} = 1)`);

/**
 * SQL fragments for other stages: each is an `EXISTS (...)` over a row alias that has a `learner_id`
 * column, e.g. `WHERE ${CONSENT_SQL.analysisConsented('e')}`. Every fragment also requires `analysis = 1`.
 */
export const CONSENT_SQL = {
  analysisConsented: consentExists('analysis'),
  shareOperatorConsented: consentExists('share_operator'),
  proposalsConsented: consentExists('proposals'),
} as const;

export const analysisConsented = CONSENT_SQL.analysisConsented;

const toConsents = (row: ConsentRow | null): InsightConsents => row ? {
  analysis: row.analysis === 1,
  shareOperator: row.share_operator === 1,
  proposals: row.proposals === 1,
  analysisAt: row.analysis_at,
  shareOperatorAt: row.share_operator_at,
  proposalsAt: row.proposals_at,
  updatedAt: row.updated_at,
} : { ...NO_INSIGHT_CONSENTS };

export async function getConsents(db: D1Database, learnerId: string): Promise<InsightConsents> {
  const row = await db.prepare(
    `SELECT analysis, share_operator, proposals, analysis_at, share_operator_at, proposals_at, updated_at
       FROM insight_consents WHERE learner_id = ?`,
  ).bind(learnerId).first<ConsentRow>();
  return toConsents(row);
}

export const ANALYSIS_REQUIRED_MESSAGE = 'Cần bật quyền phân tích (ai-tutor) trước khi bật quyền này.';

const bit = (v: boolean | undefined): number | null => (v === undefined ? null : v ? 1 : 0);

/**
 * Applies a partial consent change and returns the stored consents. Granting `shareOperator` or `proposals`
 * while `analysis` would be off throws LearningError('invalid'). Turning `analysis` off forces the other two
 * off and purges pending/processing queue rows in the same batch. Each consent that actually changed is
 * recorded as `consent.granted` / `consent.revoked` with `props.kind`.
 */
export async function setConsents(db: D1Database, learnerId: string, patch: ConsentPatch, now: Date = new Date()): Promise<InsightConsents> {
  const before = await getConsents(db, learnerId);
  const analysisAfter = patch.analysis ?? before.analysis;
  if (!analysisAfter && (patch.shareOperator === true || patch.proposals === true)) {
    throw new LearningError('invalid', ANALYSIS_REQUIRED_MESSAGE);
  }
  const ts = nowIso(now);
  const a = bit(patch.analysis);
  const s = bit(patch.shareOperator);
  const p = bit(patch.proposals);
  // ?2..?4 are the patch (NULL = unchanged). On the update path every right-hand column reference reads the
  // row as it was before this statement, so the dependent columns follow the *new* analysis value.
  const upsert = db.prepare(
    `INSERT INTO insight_consents (learner_id, analysis, share_operator, proposals, analysis_at, share_operator_at, proposals_at, updated_at)
     VALUES (?1, COALESCE(?2, 0),
             CASE WHEN COALESCE(?2, 0) = 1 THEN COALESCE(?3, 0) ELSE 0 END,
             CASE WHEN COALESCE(?2, 0) = 1 THEN COALESCE(?4, 0) ELSE 0 END,
             CASE WHEN COALESCE(?2, 0) = 1 THEN ?5 END,
             CASE WHEN COALESCE(?2, 0) = 1 AND COALESCE(?3, 0) = 1 THEN ?5 END,
             CASE WHEN COALESCE(?2, 0) = 1 AND COALESCE(?4, 0) = 1 THEN ?5 END,
             ?5)
     ON CONFLICT (learner_id) DO UPDATE SET
       analysis = COALESCE(?2, insight_consents.analysis),
       share_operator = CASE WHEN COALESCE(?2, insight_consents.analysis) = 1 THEN COALESCE(?3, insight_consents.share_operator) ELSE 0 END,
       proposals = CASE WHEN COALESCE(?2, insight_consents.analysis) = 1 THEN COALESCE(?4, insight_consents.proposals) ELSE 0 END,
       analysis_at = CASE WHEN COALESCE(?2, insight_consents.analysis) <> insight_consents.analysis THEN ?5 ELSE insight_consents.analysis_at END,
       share_operator_at = CASE
         WHEN (CASE WHEN COALESCE(?2, insight_consents.analysis) = 1 THEN COALESCE(?3, insight_consents.share_operator) ELSE 0 END) <> insight_consents.share_operator
         THEN ?5 ELSE insight_consents.share_operator_at END,
       proposals_at = CASE
         WHEN (CASE WHEN COALESCE(?2, insight_consents.analysis) = 1 THEN COALESCE(?4, insight_consents.proposals) ELSE 0 END) <> insight_consents.proposals
         THEN ?5 ELSE insight_consents.proposals_at END,
       updated_at = ?5`,
  ).bind(learnerId, a, s, p, ts);
  const stmts = [upsert];
  if (patch.analysis === false) {
    // Guarded by the consent row just written, so it only purges when analysis really ended up off.
    stmts.push(db.prepare(
      `DELETE FROM insight_events
        WHERE learner_id = ?1 AND status IN ('pending', 'processing')
          AND NOT EXISTS (SELECT 1 FROM insight_consents WHERE learner_id = ?1 AND analysis = 1)`,
    ).bind(learnerId));
  }
  await db.batch(stmts);
  const after = await getConsents(db, learnerId);

  const changes: Array<[string, boolean, boolean]> = [
    ['insights_analysis', before.analysis, after.analysis],
    ['insights_share_operator', before.shareOperator, after.shareOperator],
    ['insights_proposals', before.proposals, after.proposals],
  ];
  for (const [kind, was, is] of changes) {
    if (was === is) continue;
    await recordEventSafe(db, { learnerId, name: is ? 'consent.granted' : 'consent.revoked', props: { kind }, occurredAt: ts });
  }
  return after;
}
