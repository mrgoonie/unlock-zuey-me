/**
 * Bootstrap installer (`curl …/skill/install.mjs | node - --scope user`) against a local server that serves the real
 * bundle: success path, the piped form, and aborts on a sha256 mismatch or a traversal path that leave the
 * previously installed copy untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SKILL_FILES, skillManifest, type SkillManifest } from '../../src/lib/skill/skill-bundle';
import { makeTempEnv, runNode, SKILL_DIR, startFakeServer, type FakeReply, type FakeServer, type TempEnv } from '../fixtures/skill/skill-test-helpers';

const INSTALLER = path.join(SKILL_DIR, 'scripts', 'install.mjs');

describe('install.mjs', () => {
  let t: TempEnv;
  let server: FakeServer;
  let manifest: SkillManifest;

  /** Serves `m` and the bundled files; `override` lets a test tamper with a single file. */
  const serve = (m: SkillManifest, override: Record<string, string> = {}) => server.setResponder((req): FakeReply => {
    if (req.url === '/skill/manifest.json') return { status: 200, body: m };
    const rel = decodeURIComponent(req.url.replace(/^\/skill\/files\//, ''));
    const text = override[rel] ?? SKILL_FILES.get(rel);
    return text === undefined ? { status: 404, body: 'Not found' } : { status: 200, body: text };
  });

  beforeEach(async () => {
    t = makeTempEnv();
    server = await startFakeServer();
    manifest = await skillManifest();
    serve(manifest);
  });
  afterEach(async () => { await server.close(); t.cleanup(); });

  const target = () => path.join(t.home, '.claude', 'skills', 'ai-unlocked');
  const install = (args: string[], stdin?: string) =>
    runNode(stdin === undefined ? INSTALLER : '-', [...args, '--server', server.url], { env: t.spawnEnv(), cwd: t.cwd, stdin });

  it('installs every verified file into ~/.claude/skills/ai-unlocked', async () => {
    const r = await install(['--scope', 'user']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    for (const f of manifest.files) expect(fs.readFileSync(path.join(target(), f.path), 'utf8'), f.path).toBe(SKILL_FILES.get(f.path));
    expect(fs.existsSync(`${target()}.staging`)).toBe(false);
    expect(fs.existsSync(`${target()}.prev`)).toBe(false);
    expect(r.stdout).toContain('đã kiểm sha256');
    // Never touches Claude Code settings.
    expect(fs.existsSync(path.join(t.home, '.claude', 'settings.json'))).toBe(false);
  });

  it('works when piped to `node -`, and installs into the project with --scope project', async () => {
    const r = await install(['--scope', 'project'], fs.readFileSync(INSTALLER, 'utf8'));
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(t.cwd, '.claude', 'skills', 'ai-unlocked', 'SKILL.md'))).toBe(true);
  });

  it('a sha256 mismatch aborts and keeps the previous install', async () => {
    fs.mkdirSync(target(), { recursive: true });
    fs.writeFileSync(path.join(target(), 'SKILL.md'), 'old copy');
    serve(manifest, { 'SKILL.md': `${SKILL_FILES.get('SKILL.md')}\ntampered` });
    const r = await install(['--scope', 'user']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/sha256/);
    expect(fs.readFileSync(path.join(target(), 'SKILL.md'), 'utf8')).toBe('old copy');
    expect(fs.existsSync(`${target()}.staging`)).toBe(false);
  });

  it.each(['../evil.mjs', 'scripts/../../evil.mjs', '/etc/passwd', '.hidden'])('rejects the manifest path %s before downloading', async (bad) => {
    serve({ ...manifest, files: [...manifest.files, { path: bad, sha256: 'a'.repeat(64), bytes: 1 }] });
    const r = await install(['--scope', 'user']);
    expect(r.code).toBe(1);
    expect(fs.existsSync(target())).toBe(false);
    expect(server.requests.map((q) => q.url)).toEqual(['/skill/manifest.json']);
  });

  it('requires --scope and an https (or loopback http) server', async () => {
    expect((await runNode(INSTALLER, [], { env: t.spawnEnv(), cwd: t.cwd })).code).toBe(1);
    const insecure = await runNode(INSTALLER, ['--scope', 'user', '--server', 'http://example.com'], { env: t.spawnEnv(), cwd: t.cwd });
    expect(insecure.code).toBe(1);
    expect(insecure.stderr).toMatch(/https/);
  });
});
