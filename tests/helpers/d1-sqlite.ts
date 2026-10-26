/**
 * In-memory D1 stand-in for unit tests, backed by node:sqlite (Node 22.13+) and loaded with the real
 * migrations, so SQL in the app runs against the production schema.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Value = string | number | null | bigint | Uint8Array;

class Statement {
  private values: Value[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...values: unknown[]) {
    const s = new Statement(this.db, this.sql);
    s.values = values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : (v as Value)));
    return s;
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T = Record<string, unknown>>() {
    const rows = this.db.prepare(this.sql).all(...this.values) as T[];
    return { results: rows.map((r) => ({ ...r })), success: true, meta: {} };
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw<T = unknown[]>() {
    const stmt = this.db.prepare(this.sql);
    stmt.setReturnArrays?.(true);
    return stmt.all(...this.values) as T[];
  }
}

export function createTestD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = join(__dirname, '..', '..', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    // D1 batches are atomic and never interleave with other queries; emulate with a synchronous transaction.
    batch: async (stmts: Statement[]) => {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(s.runSync());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return d1 as unknown as D1Database;
}
