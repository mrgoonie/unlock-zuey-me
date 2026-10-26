/**
 * CI and deploy gate: fails when a D1 migration newer than the grandfathered baseline is not backward
 * compatible with the previous worker (rules in scripts/migration-safety-rules.ts, policy in
 * docs/deployment.md). The deploy workflow runs it before applying migrations.
 * Usage: bun scripts/check-migrations.ts [migrations-dir]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMigrations, GRANDFATHERED_THROUGH } from './migration-safety-rules';

const dir = process.argv[2] ?? join(import.meta.dir, '..', 'migrations');
let names: string[];
try {
  names = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
} catch (err) {
  console.error(`cannot read migrations directory ${dir}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}

const findings = checkMigrations(names.map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
const checked = names.filter((n) => Number(n.slice(0, 4)) > GRANDFATHERED_THROUGH).length;
console.log(`migrations: ${names.length} (${checked} checked, 0001-${String(GRANDFATHERED_THROUGH).padStart(4, '0')} grandfathered)`);
if (findings.length) {
  console.error(`\n${findings.length} unsafe migration statement(s):`);
  for (const f of findings) console.error(`- ${f.file}:${f.line} [${f.kind}] ${f.message}${f.statement ? `\n    ${f.statement}` : ''}`);
  process.exit(1);
}
console.log('migrations OK');
