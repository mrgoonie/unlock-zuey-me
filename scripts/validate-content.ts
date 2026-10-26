/**
 * CI gate: parses every content file with the same schemas as the app and fails on any error.
 * Usage: bun scripts/validate-content.ts
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseContent, type RawFile } from '../src/lib/content/parse-content';

const root = join(import.meta.dir, '..', 'content');
const read = (dir: string): RawFile[] =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => ({ path: join(dir, f), text: readFileSync(join(dir, f), 'utf8') }))
    : [];

const badgesPath = join(root, 'badges.yaml');
const result = parseContent({
  missions: read(join(root, 'missions')),
  concepts: read(join(root, 'concepts')),
  badges: existsSync(badgesPath) ? [{ path: badgesPath, text: readFileSync(badgesPath, 'utf8') }] : [],
});

if (result.missions.length === 0) result.errors.push(`no missions found under ${root}`);
const published = result.missions.filter((m) => m.status === 'published').length;
console.log(`missions: ${result.missions.length} (${published} published) · concepts: ${result.concepts.length} · badges: ${result.badges.length}`);
if (result.errors.length) {
  console.error(`\n${result.errors.length} content error(s):\n- ${result.errors.join('\n- ')}`);
  process.exit(1);
}
console.log('content OK');
