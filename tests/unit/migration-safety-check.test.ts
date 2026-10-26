import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMigrations, checkMigrationSql, classify, GRANDFATHERED_THROUGH, splitStatements } from '../../scripts/migration-safety-rules';

const check = (sql: string) => checkMigrationSql('0007_x.sql', sql);
const kinds = (sql: string) => check(sql).map((f) => f.kind);

describe('migration safety check', () => {
  it('accepts additive changes', () => {
    expect(check(`
      CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '');
      ALTER TABLE learners ADD COLUMN locale TEXT NOT NULL DEFAULT 'vi';
      CREATE INDEX IF NOT EXISTS idx_notes_body ON notes(body);
      CREATE UNIQUE INDEX idx_notes_unique ON notes(body);
      INSERT INTO notes (id, body) VALUES ('n1', 'DROP TABLE learners; DELETE FROM x');
    `)).toEqual([]);
  });

  it.each([
    ['DROP TABLE learners;', 'destructive'],
    ['drop index idx_runs_learner;', 'destructive'],
    ['ALTER TABLE learners DROP COLUMN deleted_at;', 'destructive'],
    ['ALTER TABLE learners RENAME TO people;', 'destructive'],
    ['ALTER TABLE learners RENAME COLUMN kind TO type;', 'destructive'],
    ['UPDATE learners SET kind = \'member\';', 'data-change'],
    ['UPDATE OR IGNORE xp_ledger SET amount = 0;', 'data-change'],
    ['DELETE FROM sessions;', 'data-change'],
    ['WITH old AS (SELECT id FROM sessions) DELETE FROM sessions WHERE id IN old;', 'data-change'],
    ['INSERT OR REPLACE INTO learners (id) VALUES (\'a\');', 'data-change'],
    ['REPLACE INTO learners (id) VALUES (\'a\');', 'data-change'],
    ['CREATE UNIQUE INDEX idx_one ON mission_runs(learner_id, mission_id);', 'constraint'],
  ])('rejects %s', (sql, kind) => {
    expect(kinds(sql)).toEqual([kind]);
  });

  it('keeps a trigger body in one statement and flags triggers on existing tables', () => {
    const sql = `CREATE TRIGGER trg AFTER INSERT ON learners BEGIN UPDATE learners SET kind = 'x' WHERE id = NEW.id; DELETE FROM sessions; END;
      CREATE TABLE t (id TEXT);`;
    expect(splitStatements(sql).map((s) => s.code.slice(0, 14))).toEqual(['CREATE TRIGGER', 'CREATE TABLE t']);
    expect(kinds(sql)).toEqual(['constraint']);
  });

  it('ignores keywords inside comments, strings and quoted identifiers', () => {
    expect(check(`-- DROP TABLE learners;
      /* DELETE FROM sessions; */
      CREATE TABLE "update" (id TEXT, note TEXT DEFAULT 'it''s; DROP TABLE x');`)).toEqual([]);
  });

  it('flags unique indexes and triggers on existing tables whatever the quoting', () => {
    for (const name of ['"learners"', '`learners`', '[learners]', 'main."learners"', '"my table"']) {
      expect(kinds(`CREATE UNIQUE INDEX ux ON ${name} (email);`)).toEqual(['constraint']);
      expect(kinds(`CREATE TRIGGER trg AFTER INSERT ON ${name} BEGIN SELECT 1; END;`)).toEqual(['constraint']);
    }
    // A table created in the same file is still exempt, whether it is quoted at creation, at use, or both.
    expect(kinds(`CREATE TABLE "fresh" (id TEXT); CREATE UNIQUE INDEX ux ON fresh (id);`)).toEqual([]);
    expect(kinds(`CREATE TABLE fresh (id TEXT); CREATE UNIQUE INDEX ux ON "Fresh" (id);`)).toEqual([]);
    expect(kinds(`CREATE TABLE "my table" (id TEXT); CREATE TRIGGER t AFTER INSERT ON [my table] BEGIN SELECT 1; END;`)).toEqual([]);
    // Keywords inside a quoted column name still never match.
    expect(kinds(`ALTER TABLE learners ADD COLUMN "drop" TEXT;`)).toEqual([]);
  });

  it('reports the line where the statement starts', () => {
    expect(check('CREATE TABLE a (id TEXT);\n\n-- tidy up\nDELETE\n FROM sessions;')[0]).toMatchObject({ line: 4, kind: 'data-change' });
  });

  describe('allow marker', () => {
    it('allows a statement whose comment names its kind and a reason', () => {
      expect(check(`-- migration-allow: data-change backfill only touches rows the old worker never reads
        UPDATE learners SET kind = 'guest' WHERE kind IS NULL;`)).toEqual([]);
      expect(check(`/* migration-allow: destructive column unused since release 2026-10-20 */
        ALTER TABLE learners DROP COLUMN legacy;`)).toEqual([]);
    });

    it('applies only to the statement it precedes', () => {
      expect(kinds(`-- migration-allow: data-change backfill only touches rows the old worker never reads
        UPDATE learners SET kind = 'guest' WHERE kind IS NULL;
        DELETE FROM sessions;`)).toEqual(['data-change']);
    });

    it('must name the right kind', () => {
      expect(kinds(`-- migration-allow: data-change wrong kind for a drop statement
        DROP TABLE learners;`)).toEqual(['destructive']);
    });

    it('needs a real reason', () => {
      const [f] = check(`-- migration-allow: data-change ok
        DELETE FROM sessions;`);
      expect(f.message).toMatch(/needs a reason/);
    });
  });

  describe('files', () => {
    it('grandfathers migrations up to the baseline and checks every later one', () => {
      const bad = 'DELETE FROM sessions;';
      const findings = checkMigrations([
        { name: '0004_learning_integrity.sql', sql: bad },
        { name: '0007_next.sql', sql: bad },
      ]);
      expect(findings.map((f) => f.file)).toEqual(['0007_next.sql']);
    });

    it('rejects file names wrangler would mis-order and duplicate numbers', () => {
      const findings = checkMigrations([
        { name: '0007_a.sql', sql: '' },
        { name: '0007_b.sql', sql: '' },
        { name: '8_late.sql', sql: '' },
      ]);
      expect(findings.map((f) => [f.file, f.kind])).toEqual([['0007_b.sql', 'naming'], ['8_late.sql', 'naming']]);
    });

    it('passes on the migrations in this repository', () => {
      const dir = join(__dirname, '..', '..', 'migrations');
      const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
      expect(files.length).toBeGreaterThanOrEqual(GRANDFATHERED_THROUGH);
      expect(checkMigrations(files)).toEqual([]);
    });

    it('would have flagged migration 0004 without the baseline', () => {
      const sql = readFileSync(join(__dirname, '..', '..', 'migrations', '0004_learning_integrity.sql'), 'utf8');
      expect(new Set(checkMigrationSql('0004_learning_integrity.sql', sql).map((f) => f.kind))).toEqual(new Set(['data-change', 'constraint']));
    });
  });

  it('classifies additive statements as safe', () => {
    expect(classify('CREATE TABLE x (id TEXT)')).toBeNull();
    expect(classify('ALTER TABLE x ADD COLUMN y TEXT')).toBeNull();
    expect(classify('INSERT INTO x (id) VALUES (\'\')')).toBeNull();
  });
});
