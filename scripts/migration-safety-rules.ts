/**
 * Expand/contract guard for D1 migrations (docs/deployment.md). The deploy applies migrations BEFORE the
 * new worker goes live, so for a short window the previous worker runs on the new schema. Every migration
 * must therefore be backward compatible with the previous worker: additive changes only (new tables, new
 * columns with defaults, new non-unique indexes, plain INSERTs).
 *
 * A statement that can break the previous worker or rewrite data is rejected unless the comments right
 * before it (or inside it) carry an explicit allow marker naming its kind and a reason:
 *
 *   -- migration-allow: destructive   <reason>  DROP TABLE/VIEW/INDEX/TRIGGER, ALTER TABLE ... DROP/RENAME
 *   -- migration-allow: data-change   <reason>  UPDATE, DELETE, REPLACE / INSERT OR REPLACE
 *   -- migration-allow: constraint    <reason>  CREATE UNIQUE INDEX on an existing table, CREATE TRIGGER
 *
 * Pure logic (no file system) so it is unit-tested; scripts/check-migrations.ts is the CLI.
 */

export type RiskKind = 'destructive' | 'data-change' | 'constraint';

export interface MigrationFinding {
  file: string;
  /** 1-based line where the offending statement starts. */
  line: number;
  /** 'naming' = the file name breaks wrangler's ordering, not a SQL risk. */
  kind: RiskKind | 'naming';
  /** First characters of the statement (comments and string contents removed). */
  statement: string;
  message: string;
}

interface Statement {
  /** SQL with comments removed and string literal contents blanked; whitespace collapsed. */
  code: string;
  /** Text of every comment that precedes or sits inside the statement. */
  comments: string[];
  line: number;
}

const MARKER = /migration-allow:\s*(destructive|data-change|constraint)\b\s*(.*)$/i;
/** A reason must say something; "ok" or "x" does not explain why the old worker is safe. */
const MIN_REASON_LENGTH = 10;

/**
 * Splits SQL into statements, separating comments from code and blanking string literals so keywords
 * inside strings or comments never match. Trigger bodies (BEGIN ... END) stay one statement.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let code = '';
  let comments: string[] = [];
  let line = 1;
  let startLine = 0;
  const push = () => {
    const text = code.replace(/\s+/g, ' ').trim();
    if (text) out.push({ code: text, comments, line: startLine || line });
    code = '';
    comments = [];
    startLine = 0;
  };
  const addCode = (s: string) => {
    if (!startLine && s.trim()) startLine = line;
    code += s;
  };

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '\n') {
      line++;
      code += ' ';
    } else if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      comments.push(sql.slice(i + 2, stop));
      i = stop - 1;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      const body = sql.slice(i + 2, end === -1 ? sql.length : end);
      comments.push(...body.split('\n'));
      line += body.split('\n').length - 1;
      i = stop - 1;
      code += ' ';
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      // String literal or quoted identifier: keep the quotes, blank the contents ('' escapes stay inside).
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === '\n') line++;
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            j++;
            continue;
          }
          break;
        }
      }
      addCode(c === "'" ? "''" : `${c}x${close}`);
      i = j;
    } else if (c === ';') {
      const text = code.replace(/\s+/g, ' ').trim();
      // A trigger body holds its own semicolons; the statement ends at the END that closes it.
      if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(text) && !/\bEND$/i.test(text)) code += ';';
      else push();
    } else {
      addCode(c);
    }
  }
  push();
  return out;
}

/** Tables created in this file: indexes and triggers on them cannot affect the previous worker. */
function createdTables(statements: Statement[]): Set<string> {
  const names = new Set<string>();
  for (const s of statements) {
    const m = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s.code);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

/** The risk of one statement, or null when it is additive. */
export function classify(code: string, newTables: Set<string> = new Set()): { kind: RiskKind; message: string } | null {
  if (/^DROP\s+(TABLE|VIEW|INDEX|TRIGGER)\b/i.test(code)) {
    return { kind: 'destructive', message: 'DROP removes something the previous worker may still use' };
  }
  if (/^ALTER\s+TABLE\b.*\bDROP\b/i.test(code)) {
    return { kind: 'destructive', message: 'dropping a column breaks the previous worker that still reads or writes it' };
  }
  if (/^ALTER\s+TABLE\b.*\bRENAME\b/i.test(code)) {
    return { kind: 'destructive', message: 'renaming breaks the previous worker that still uses the old name' };
  }
  if (/^(WITH\b.*?\b)?(UPDATE|DELETE|REPLACE)\b/i.test(code) || /^INSERT\s+OR\s+REPLACE\b/i.test(code)) {
    return { kind: 'data-change', message: 'rewrites existing rows while the previous worker is still serving' };
  }
  const unique = /^CREATE\s+UNIQUE\s+INDEX\b.*?\bON\s+(\w+)/i.exec(code);
  if (unique && !newTables.has(unique[1].toLowerCase())) {
    return { kind: 'constraint', message: 'a unique index on an existing table can reject writes of the previous worker' };
  }
  const trigger = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b.*?\bON\s+(\w+)/i.exec(code);
  if (trigger && !newTables.has(trigger[1].toLowerCase())) {
    return { kind: 'constraint', message: 'a trigger on an existing table changes what writes of the previous worker do' };
  }
  return null;
}

function allowed(comments: string[], kind: RiskKind): { ok: true } | { ok: false; why?: string } {
  for (const c of comments) {
    const m = MARKER.exec(c.trim());
    if (!m || m[1].toLowerCase() !== kind) continue;
    if (m[2].trim().length < MIN_REASON_LENGTH) return { ok: false, why: `the "${kind}" allow marker needs a reason (${MIN_REASON_LENGTH}+ characters)` };
    return { ok: true };
  }
  return { ok: false };
}

/** Findings for one migration file's SQL. */
export function checkMigrationSql(file: string, sql: string): MigrationFinding[] {
  const statements = splitStatements(sql);
  const newTables = createdTables(statements);
  const findings: MigrationFinding[] = [];
  for (const s of statements) {
    const risk = classify(s.code, newTables);
    if (!risk) continue;
    const verdict = allowed(s.comments, risk.kind);
    if (verdict.ok) continue;
    findings.push({
      file,
      line: s.line,
      kind: risk.kind,
      statement: s.code.slice(0, 80),
      message: verdict.why ?? `${risk.message}; split it across two releases (docs/deployment.md) or add "-- migration-allow: ${risk.kind} <reason>"`,
    });
  }
  return findings;
}

/**
 * Migrations up to and including this number were applied before the guard existed and were reviewed by
 * hand (0004 rewrites rows and adds a unique index), so they are not checked. Every later file is.
 */
export const GRANDFATHERED_THROUGH = 6;
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Checks every file newer than the grandfathered baseline; also rejects files wrangler would mis-order. */
export function checkMigrations(files: { name: string; sql: string }[], baseline = GRANDFATHERED_THROUGH): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const seen = new Map<number, string>();
  for (const { name, sql } of files) {
    const m = MIGRATION_FILE.exec(name);
    if (!m) {
      findings.push({ file: name, line: 1, kind: 'naming', statement: '', message: 'migration file names must look like 0007_short_name.sql' });
      continue;
    }
    const n = Number(m[1]);
    const dup = seen.get(n);
    if (dup) findings.push({ file: name, line: 1, kind: 'naming', statement: '', message: `same number as ${dup}` });
    seen.set(n, name);
    if (n > baseline) findings.push(...checkMigrationSql(name, sql));
  }
  return findings;
}
