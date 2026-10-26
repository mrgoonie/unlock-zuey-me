/** The learning integrity migration: duplicate open runs abandoned before the unique index, mission XP re-keyed. */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '..', '..', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const target = files.find((f) => f.includes('learning_integrity'))!;
const apply = (db: DatabaseSync) => db.exec(readFileSync(join(dir, target), 'utf8'));

function dbBefore(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of files.slice(0, files.indexOf(target))) db.exec(readFileSync(join(dir, f), 'utf8'));
  db.exec(`INSERT INTO learners (id, kind, created_at, updated_at) VALUES ('lrn_a', 'guest', 'x', 'x')`);
  return db;
}

const run = (db: DatabaseSync, id: string, mission: string, status: string, updatedAt: string) =>
  db.prepare(`INSERT INTO mission_runs (id, learner_id, mission_id, mission_version, status, started_at, updated_at) VALUES (?, 'lrn_a', ?, 1, ?, 'x', ?)`)
    .run(id, mission, status, updatedAt);

describe('learning integrity migration', () => {
  it('keeps only the newest open run per mission and adds the unique index', () => {
    const db = dbBefore();
    run(db, 'run_1', 'plan-weekend', 'started', '2026-10-01T00:00:00Z');
    run(db, 'run_2', 'plan-weekend', 'needs_revision', '2026-10-03T00:00:00Z');
    run(db, 'run_3', 'plan-weekend', 'paused', '2026-10-02T00:00:00Z');
    run(db, 'run_4', 'plan-weekend', 'completed', '2026-10-04T00:00:00Z');
    run(db, 'run_5', 'other', 'started', '2026-10-01T00:00:00Z');
    apply(db);
    const rows = db.prepare('SELECT id, status, revealed_json FROM mission_runs ORDER BY id').all() as Array<{ id: string; status: string; revealed_json: string }>;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      run_1: 'abandoned', run_2: 'needs_revision', run_3: 'abandoned', run_4: 'completed', run_5: 'started',
    });
    expect(rows.every((r) => r.revealed_json === '[]')).toBe(true);
    expect(() => run(db, 'run_6', 'plan-weekend', 'started', 'x')).toThrow(/UNIQUE/);
    expect(() => run(db, 'run_7', 'plan-weekend', 'completed', 'x')).not.toThrow();
  });

  it('re-keys the first mission_pass per mission to the mission id and keeps earlier repeat XP', () => {
    const db = dbBefore();
    run(db, 'run_1', 'plan-weekend', 'completed', 'x');
    run(db, 'run_2', 'plan-weekend', 'completed', 'x');
    db.exec(`INSERT INTO xp_ledger (id, learner_id, amount, reason, ref, created_at) VALUES
      ('xp1', 'lrn_a', 100, 'mission_pass', 'run_1', 'x'), ('xp2', 'lrn_a', 100, 'mission_pass', 'run_2', 'x'),
      ('xp3', 'lrn_a', 10, 'other', 'run_1', 'x')`);
    apply(db);
    expect(db.prepare('SELECT id, ref FROM xp_ledger ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { id: 'xp1', ref: 'plan-weekend' }, { id: 'xp2', ref: 'run_2' }, { id: 'xp3', ref: 'run_1' },
    ]);
  });
});
