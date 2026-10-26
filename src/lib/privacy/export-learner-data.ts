/**
 * Data export ("tải dữ liệu của tôi"): every row the learner owns across all tables, with JSON columns
 * expanded, plus the R2 keys of their evidence images. Never includes another learner's rows.
 */
import { nowIso } from '../db/ids';
import { evidencePrefix, expandJsonColumns, LEARNER_TABLES, ownedLearnerIds } from './learner-data-tables';

export interface LearnerExport {
  format: 'ai-unlocked-export';
  version: 1;
  exportedAt: string;
  learnerId: string;
  learners: Record<string, unknown>[];
  tables: Record<string, Record<string, unknown>[]>;
  /** Keys of evidence images (stored privately in R2; viewable in the app while signed in). */
  imageKeys: string[];
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Lists every R2 key under a prefix, following pagination. */
export async function listR2Keys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function exportLearnerData(db: D1Database, bucket: R2Bucket | undefined, learnerId: string): Promise<LearnerExport> {
  const ids = await ownedLearnerIds(db, learnerId);
  const inList = placeholders(ids.length);

  const learners = await db.prepare(`SELECT * FROM learners WHERE id IN (${inList}) ORDER BY created_at`).bind(...ids).all();
  const tables: LearnerExport['tables'] = {};
  for (const t of LEARNER_TABLES) {
    // Table and column names come from the constant list above, never from input.
    const rows = await db.prepare(`SELECT * FROM ${t.table} WHERE ${t.column} IN (${inList})`).bind(...ids).all();
    tables[t.table] = rows.results.map((r) => expandJsonColumns(r as Record<string, unknown>, t.omitFromExport));
  }

  const imageKeys = new Set<string>();
  for (const s of tables.evidence_submissions ?? []) {
    if (Array.isArray(s.image_keys)) for (const k of s.image_keys) if (typeof k === 'string') imageKeys.add(k);
  }
  if (bucket) {
    for (const id of ids) for (const k of await listR2Keys(bucket, evidencePrefix(id))) imageKeys.add(k);
  }

  return {
    format: 'ai-unlocked-export',
    version: 1,
    exportedAt: nowIso(),
    learnerId,
    learners: learners.results.map((r) => expandJsonColumns(r as Record<string, unknown>)),
    tables,
    imageKeys: [...imageKeys].sort(),
  };
}
