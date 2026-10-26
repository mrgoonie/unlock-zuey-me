/** /skill/** routes: the bundled files equal the repo files byte for byte, the manifest hashes match, and every route 404s while INSIGHTS_MODE is off. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SKILL_VERSION } from '../../skills/ai-unlocked/scripts/lib/constants.mjs';
import { LATEST_SKILL_VERSION } from '../../src/lib/insights/ingest-service';
import { SKILL_FILES, skillManifest } from '../../src/lib/skill/skill-bundle';
import { serveSkillFile, serveSkillManifest, skillRoutesEnabled } from '../../src/lib/skill/skill-routes';
import { SKILL_DIR } from '../fixtures/skill/skill-test-helpers';

const env = (mode: string | undefined) => ({ INSIGHTS_MODE: mode }) as Pick<Env, 'INSIGHTS_MODE'>;

function diskFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.name.startsWith('.')) return [];
    return e.isDirectory() ? diskFiles(path.join(dir, e.name), rel) : [rel];
  });
}

describe('skill bundle', () => {
  it('serves every repo file of the skill, unchanged', () => {
    const disk = diskFiles(SKILL_DIR).filter((p) => !/\.test\.[a-z]+$/.test(p)).sort();
    expect([...SKILL_FILES.keys()].sort()).toEqual(disk);
    for (const [rel, text] of SKILL_FILES) expect(text, rel).toBe(fs.readFileSync(path.join(SKILL_DIR, rel), 'utf8'));
  });

  it('manifest lists sha256 and byte length of each file and the package version', async () => {
    const manifest = await skillManifest();
    expect(manifest).toMatchObject({ name: 'ai-unlocked', version: SKILL_VERSION, minNode: 18, hookMarker: 'v1' });
    expect(manifest.files.map((f) => f.path)).toContain('SKILL.md');
    expect(manifest.files.map((f) => f.path)).toContain('scripts/install.mjs');
    for (const f of manifest.files) {
      const bytes = fs.readFileSync(path.join(SKILL_DIR, f.path));
      expect(f.bytes, f.path).toBe(bytes.length);
      expect(f.sha256, f.path).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('the status endpoint reports the shipped skill version', () => {
    expect(LATEST_SKILL_VERSION).toBe(SKILL_VERSION);
  });
});

describe('skill routes', () => {
  it.each([undefined, 'off', 'OFF', 'garbage'])('INSIGHTS_MODE=%s → every route 404', async (mode) => {
    expect(skillRoutesEnabled(env(mode))).toBe(false);
    expect((await serveSkillManifest(env(mode))).status).toBe(404);
    expect(serveSkillFile(env(mode), 'SKILL.md').status).toBe(404);
    expect(serveSkillFile(env(mode), 'scripts/install.mjs').status).toBe(404);
  });

  it.each(['internal', 'pilot', 'on'])('INSIGHTS_MODE=%s serves the manifest and files as text/plain', async (mode) => {
    const manifest = await serveSkillManifest(env(mode));
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as { version: string }).version).toBe(SKILL_VERSION);
    const file = serveSkillFile(env(mode), 'scripts/install.mjs');
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await file.text()).toBe(fs.readFileSync(path.join(SKILL_DIR, 'scripts/install.mjs'), 'utf8'));
  });

  it('unknown or traversal paths are 404', () => {
    for (const p of ['../package.json', 'scripts/../../package.json', 'nope.md', '', undefined]) {
      expect(serveSkillFile(env('on'), p).status).toBe(404);
    }
  });
});
