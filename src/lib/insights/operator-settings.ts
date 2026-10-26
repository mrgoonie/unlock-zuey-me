/**
 * Operator runtime settings of the insights proposal pipeline (`insight_operator_settings`, key/value).
 *
 * - `safe_auto_implement` ('1' | '0', default off): the DB half of the two independent switches that
 *   allow automatic `ai-handle` (the env half is INSIGHTS_GITHUB_ISSUES=issues_ai_handle).
 * - Internal pipeline state written by the system actor `system:insights`: the proposal stage's durable
 *   cursors and the per-UTC-day issue counter (see proposal-store.ts). They live here because this table is
 *   the only learner-free key/value store of the feature.
 */

export const SAFE_AUTO_IMPLEMENT_KEY = 'safe_auto_implement';
/** Actor recorded on rows the cron stage writes. No learner owns this id. */
export const SYSTEM_ACTOR = 'system:insights';

export async function readSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM insight_operator_settings WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export function writeSettingStatement(db: D1Database, key: string, value: string, actor: string, now: Date): D1PreparedStatement {
  return db.prepare(`INSERT INTO insight_operator_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(key, value, actor, now.toISOString());
}

export async function writeSetting(db: D1Database, key: string, value: string, actor: string, now: Date): Promise<void> {
  await writeSettingStatement(db, key, value, actor, now).run();
}

/** Whether the operator allowed automatic `ai-handle` for gate-passing low-risk proposals. Missing → off. */
export async function getSafeAutoImplement(db: D1Database): Promise<boolean> {
  return (await readSetting(db, SAFE_AUTO_IMPLEMENT_KEY)) === '1';
}

export async function setSafeAutoImplement(db: D1Database, value: boolean, adminId: string, now: Date = new Date()): Promise<boolean> {
  await writeSetting(db, SAFE_AUTO_IMPLEMENT_KEY, value ? '1' : '0', adminId, now);
  return value;
}
