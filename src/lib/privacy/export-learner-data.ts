/**
 * Data export ("tải dữ liệu của tôi"): every row the learner owns across all tables (directly, or through
 * their runs, e.g. run_hints), with JSON columns expanded, plus the R2 keys of their evidence images. Never
 * includes another learner's rows.
 *
 * The export is bounded so it always fits in one Worker invocation: each table contributes at most
 * EXPORT_LIMITS.rowsPerTable rows and the whole document at most EXPORT_LIMITS.maxBytes of row JSON. A table
 * cut off by either bound is listed in `continuation` with a URL that returns its next page
 * (`exportLearnerTablePage`), keyed by SQLite rowid so pages are stable while new rows are added.
 */
import { nowIso } from '../db/ids';
import { LearningError } from '../learning/types';
import {
  evidencePrefix, expandJsonColumns, LEARNER_TABLES, ownedLearnerIds, RUN_OWNED_TABLES, type LearnerTable,
} from './learner-data-tables';

export const EXPORT_LIMITS = {
  rowsPerTable: 1000,
  /** Budget for serialized row JSON in one response (the Worker has 128 MB and pretty-prints the result). */
  maxBytes: 8 * 1024 * 1024,
  maxImageKeys: 5000,
} as const;

export const EXPORT_PATH = '/api/v1/me/export';

export interface ExportContinuation {
  /** Pass as `after` to fetch the next page of this table. */
  after: number;
  url: string;
}

export interface LearnerExport {
  format: 'ai-unlocked-export';
  version: 1;
  exportedAt: string;
  learnerId: string;
  learners: Record<string, unknown>[];
  tables: Record<string, Record<string, unknown>[]>;
  /** Keys of evidence images (stored privately in R2; viewable in the app while signed in). */
  imageKeys: string[];
  /** Tables with more rows than fit in this file, and where to fetch the rest. Empty when complete. */
  continuation: Record<string, ExportContinuation>;
  note?: string;
}

export interface LearnerExportPage {
  format: 'ai-unlocked-export-page';
  version: 1;
  exportedAt: string;
  learnerId: string;
  table: string;
  rows: Record<string, unknown>[];
  /** Null when this was the last page. */
  next: ExportContinuation | null;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
const ROWID = '__export_rowid';

/** A table in the export; `viaRuns` tables are owned through the learner's mission runs. */
interface ExportTable extends LearnerTable {
  viaRuns?: boolean;
}

/** Every exported table, in export order: learner-owned tables, then tables owned through runs. */
const EXPORT_TABLES: ExportTable[] = [...LEARNER_TABLES, ...RUN_OWNED_TABLES.map((t) => ({ ...t, viaRuns: true }))];

/** SQL condition selecting the rows of `t` owned by `idCount` learner ids (bound as parameters). */
const ownerCondition = (t: ExportTable, idCount: number): string => (t.viaRuns
  ? `${t.column} IN (SELECT id FROM mission_runs WHERE learner_id IN (${placeholders(idCount)}))`
  : `${t.column} IN (${placeholders(idCount)})`);

/** Lists R2 keys under a prefix, following pagination, up to `max` keys. */
export async function listR2Keys(bucket: R2Bucket, prefix: string, max = Number.POSITIVE_INFINITY): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && keys.length < max);
  return keys.slice(0, max);
}

const continuationFor = (table: string, after: number): ExportContinuation => ({
  after, url: `${EXPORT_PATH}?table=${encodeURIComponent(table)}&after=${after}`,
});

/**
 * One page of a table: rows after `after` (rowid), at most `rowLimit` rows and roughly `byteBudget` bytes
 * (at least one row, so paging always progresses). `next` is the last rowid when more rows remain.
 */
async function readTablePage(
  db: D1Database, t: ExportTable, ids: string[], after: number, rowLimit: number, byteBudget: number,
): Promise<{ rows: Record<string, unknown>[]; bytes: number; next: number | null }> {
  // Table and column names come from the EXPORT_TABLES constant, never from input.
  const { results } = await db.prepare(
    `SELECT rowid AS ${ROWID}, * FROM ${t.table} WHERE ${ownerCondition(t, ids.length)} AND rowid > ?
     ORDER BY rowid LIMIT ?`,
  ).bind(...ids, after, rowLimit + 1).all<Record<string, unknown>>();
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  let last = after;
  for (const raw of results.slice(0, rowLimit)) {
    const { [ROWID]: rowid, ...rest } = raw;
    const row = expandJsonColumns(rest, t.omitFromExport);
    const size = JSON.stringify(row).length;
    if (rows.length > 0 && bytes + size > byteBudget) return { rows, bytes, next: last };
    rows.push(row);
    bytes += size;
    last = Number(rowid);
  }
  return { rows, bytes, next: results.length > rowLimit ? last : null };
}

export async function exportLearnerData(db: D1Database, bucket: R2Bucket | undefined, learnerId: string): Promise<LearnerExport> {
  const ids = await ownedLearnerIds(db, learnerId);

  const learners = await db.prepare(`SELECT * FROM learners WHERE id IN (${placeholders(ids.length)}) ORDER BY created_at`).bind(...ids).all();
  const tables: LearnerExport['tables'] = {};
  const continuation: LearnerExport['continuation'] = {};
  let remaining = EXPORT_LIMITS.maxBytes;
  for (const t of EXPORT_TABLES) {
    if (remaining <= 0) {
      tables[t.table] = [];
      continuation[t.table] = continuationFor(t.table, 0);
      continue;
    }
    const page = await readTablePage(db, t, ids, 0, EXPORT_LIMITS.rowsPerTable, remaining);
    tables[t.table] = page.rows;
    remaining -= page.bytes;
    if (page.next !== null) continuation[t.table] = continuationFor(t.table, page.next);
  }

  const imageKeys = new Set<string>();
  for (const s of tables.evidence_submissions ?? []) {
    if (Array.isArray(s.image_keys)) for (const k of s.image_keys) if (typeof k === 'string') imageKeys.add(k);
  }
  if (bucket) {
    for (const id of ids) {
      if (imageKeys.size >= EXPORT_LIMITS.maxImageKeys) break;
      for (const k of await listR2Keys(bucket, evidencePrefix(id), EXPORT_LIMITS.maxImageKeys - imageKeys.size)) imageKeys.add(k);
    }
  }

  const complete = Object.keys(continuation).length === 0;
  return {
    format: 'ai-unlocked-export',
    version: 1,
    exportedAt: nowIso(),
    learnerId,
    learners: learners.results.map((r) => expandJsonColumns(r as Record<string, unknown>)),
    tables,
    imageKeys: [...imageKeys].sort(),
    continuation,
    ...(complete ? {} : {
      note: 'Dữ liệu của bạn nhiều hơn một tệp. Mở từng đường dẫn trong "continuation" (khi đang đăng nhập) để tải phần còn lại.',
    }),
  };
}

/** The next page of one table of the export (see `continuation`). `table` comes from the query string. */
export async function exportLearnerTablePage(db: D1Database, learnerId: string, table: string, after: number): Promise<LearnerExportPage> {
  const t = EXPORT_TABLES.find((x) => x.table === table);
  if (!t) throw new LearningError('invalid', 'Bảng dữ liệu không hợp lệ.');
  if (!Number.isSafeInteger(after) || after < 0) throw new LearningError('invalid', 'Tham số after không hợp lệ.');
  const ids = await ownedLearnerIds(db, learnerId);
  const page = await readTablePage(db, t, ids, after, EXPORT_LIMITS.rowsPerTable, EXPORT_LIMITS.maxBytes);
  return {
    format: 'ai-unlocked-export-page',
    version: 1,
    exportedAt: nowIso(),
    learnerId,
    table: t.table,
    rows: page.rows,
    next: page.next === null ? null : continuationFor(t.table, page.next),
  };
}
