/**
 * Every D1 table holding learner-owned rows, with the column that points at the learner. Export and delete
 * both iterate this list, so a table added here is covered by both. Order matters for delete: children
 * before parents (foreign keys are enforced).
 *
 * When a migration adds a learner-owned table, add it here; tests/unit/privacy-data-rights.test.ts fails
 * if any table with a learner_id column is missing.
 */

export interface LearnerTable {
  table: string;
  /** Column holding the learner id. */
  column: string;
  /**
   * Columns left out of the export because they are credentials, not personal data
   * (session token hashes, PKCE verifiers, push endpoint capability URLs and keys).
   */
  omitFromExport?: string[];
}

export const LEARNER_TABLES: LearnerTable[] = [
  { table: 'evaluations', column: 'learner_id' },
  { table: 'evidence_submissions', column: 'learner_id' },
  { table: 'xp_ledger', column: 'learner_id' },
  { table: 'badge_grants', column: 'learner_id' },
  { table: 'competency_scores', column: 'learner_id' },
  { table: 'activity_days', column: 'learner_id' },
  { table: 'lab_runs', column: 'learner_id' },
  { table: 'concept_views', column: 'learner_id' },
  { table: 'coach_messages', column: 'learner_id' },
  { table: 'mission_runs', column: 'learner_id' },
  { table: 'certificates', column: 'learner_id' },
  { table: 'push_subscriptions', column: 'learner_id', omitFromExport: ['endpoint', 'p256dh', 'auth'] },
  // ai-tutor insights (0008). insight_signal_evidence has no learner column: it cascades from insight_reports.
  { table: 'insight_access_audit', column: 'learner_id' },
  { table: 'insight_events', column: 'learner_id' },
  { table: 'insight_reports', column: 'learner_id' },
  { table: 'insight_tokens', column: 'learner_id', omitFromExport: ['token_hash'] },
  { table: 'insight_consents', column: 'learner_id' },
  { table: 'ai_usage', column: 'learner_id' },
  { table: 'events', column: 'learner_id' },
  { table: 'feedback', column: 'learner_id' },
  { table: 'sessions', column: 'learner_id', omitFromExport: ['token_hash'] },
  { table: 'login_requests', column: 'learner_id', omitFromExport: ['code_verifier', 'state', 'oauth_request_json'] },
];

/**
 * Tables whose rows belong to the learner through one of their runs (`column` holds a mission_runs id; there
 * is no learner column). The export reads them via the runs of the learner and merged guests; delete and
 * guest cleanup need no entry because deleting a run cascades to them (ON DELETE CASCADE).
 */
export const RUN_OWNED_TABLES: LearnerTable[] = [
  { table: 'run_hints', column: 'run_id' },
];

/** R2 prefix under which the engine stores a learner's evidence images. */
export const evidencePrefix = (learnerId: string) => `ev/${learnerId}/`;

/**
 * The learner plus guest rows that were merged into it at sign-in. Merged guests are the same person, so
 * their leftover rows belong to this learner's export and deletion.
 */
export async function ownedLearnerIds(db: D1Database, learnerId: string): Promise<string[]> {
  const merged = await db.prepare('SELECT id FROM learners WHERE merged_into = ?').bind(learnerId).all<{ id: string }>();
  return [learnerId, ...merged.results.map((r) => r.id)];
}

/** Parses *_json columns so the export reads as nested JSON instead of escaped strings. */
export function expandJsonColumns(row: Record<string, unknown>, omit: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (omit.includes(k)) continue;
    if (k.endsWith('_json') && typeof v === 'string') {
      try {
        out[k.slice(0, -5)] = JSON.parse(v);
        continue;
      } catch {
        // Corrupt JSON is exported as the raw string.
      }
    }
    out[k] = v;
  }
  return out;
}
