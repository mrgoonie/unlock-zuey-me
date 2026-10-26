/** ai-unlocked settings merge: marker-based install/upgrade/uninstall that never disturbs foreign hooks. */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyToFile, findMarkerHandlers, planInstall, planUninstall, SettingsError, unifiedDiff,
} from '../../skills/ai-unlocked/scripts/lib/settings-merge.mjs';
import { installHook, uninstallHook } from '../../skills/ai-unlocked/scripts/lib/hook-installer.mjs';
import { makeTempEnv, readFixture, type TempEnv } from '../fixtures/skill/skill-test-helpers';

const CMD = '"/usr/local/bin/node" "/home/me/.claude/skills/ai-unlocked/scripts/stop-hook.mjs" --ai-unlocked-hook=v1';
const parse = (rel: string) => JSON.parse(readFixture(rel)) as Record<string, any>;
const foreignOnly = (json: any) => {
  const out: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(json?.hooks ?? {})) {
    out[event] = (groups as any[]).map((g) => ({ ...g, hooks: g.hooks.filter((h: any) => !String(h.command ?? '').includes('--ai-unlocked-hook=')) }))
      .filter((g) => g.hooks.length > 0);
  }
  return out;
};

describe('planInstall / planUninstall (pure)', () => {
  it('appends one Stop group to an empty file and never writes SubagentStop', () => {
    const { changed, json } = planInstall({}, CMD);
    expect(changed).toBe(true);
    expect(json).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD, timeout: 10 }] }] } });
    expect(json.hooks.SubagentStop).toBeUndefined();
  });

  it('is idempotent: a second install changes nothing and leaves exactly one marker', () => {
    const once = planInstall(parse('settings/user-with-foreign-hooks.json'), CMD).json;
    const twice = planInstall(once, CMD);
    expect(twice.changed).toBe(false);
    expect(findMarkerHandlers(twice.json)).toHaveLength(1);
  });

  it('keeps foreign Stop and PreToolUse handlers and every other key deep-equal', () => {
    const original = parse('settings/user-with-foreign-hooks.json');
    const installed = planInstall(original, CMD).json;
    expect(foreignOnly(installed)).toEqual(original.hooks);
    expect({ ...installed, hooks: undefined }).toEqual({ ...original, hooks: undefined });
    expect(planUninstall(installed).json).toEqual(original);
  });

  it('upgrades a v0 marker in place and collapses duplicates (including a stray SubagentStop copy)', () => {
    const original = parse('settings/local-with-v0-and-duplicate-markers.json');
    const { json } = planInstall(original, CMD);
    const markers = findMarkerHandlers(json);
    expect(markers).toEqual([{ event: 'Stop', group: 0, index: 1, command: CMD }]);
    expect(json.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'echo foreign-before' });
    expect(json.hooks.Stop).toHaveLength(1);
    expect(json.hooks.SubagentStop).toBeUndefined();
    expect(json.permissions).toEqual(original.permissions);
  });

  it('uninstall removes only marker handlers and prunes empty groups, events and hooks', () => {
    const { json } = planUninstall(planInstall({ model: 'x' }, CMD).json);
    expect(json).toEqual({ model: 'x' });
    expect(planUninstall({ model: 'x' }).changed).toBe(false);
  });

  it('rejects a non-object root or a malformed hooks section', () => {
    expect(() => planInstall([], CMD)).toThrow(SettingsError);
    expect(() => planInstall({ hooks: [] }, CMD)).toThrow(SettingsError);
    expect(() => planInstall({ hooks: { Stop: {} } }, CMD)).toThrow(SettingsError);
  });

  it('unifiedDiff shows the added handler', () => {
    const diff = unifiedDiff('{\n  "a": 1\n}\n', '{\n  "a": 1,\n  "b": 2\n}\n', 'settings.json');
    expect(diff).toContain('-  "a": 1');
    expect(diff).toContain('+  "b": 2');
  });
});

describe('applyToFile and scopes on disk', () => {
  let t: TempEnv;
  beforeEach(() => { t = makeTempEnv(); });
  afterEach(() => t.cleanup());

  const userFile = () => path.join(t.home, '.claude', 'settings.json');
  const sharedFile = () => path.join(t.cwd, '.claude', 'settings.json');
  const localFile = () => path.join(t.cwd, '.claude', 'settings.local.json');
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

  it('user scope: install → install → uninstall restores the original bytes (2-space file)', () => {
    const original = `${JSON.stringify(parse('settings/user-with-foreign-hooks.json'), null, 2)}\n`;
    put(userFile(), original);
    installHook({ ctx: t.ctx, scope: 'user', command: CMD });
    installHook({ ctx: t.ctx, scope: 'user', command: CMD });
    const installed = JSON.parse(fs.readFileSync(userFile(), 'utf8'));
    expect(findMarkerHandlers(installed)).toHaveLength(1);
    expect(installed.hooks.PreToolUse).toEqual(parse('settings/user-with-foreign-hooks.json').hooks.PreToolUse);
    expect(fs.existsSync(`${userFile()}.ai-unlocked.bak`)).toBe(false);
    uninstallHook({ ctx: t.ctx, scope: 'user' });
    expect(fs.readFileSync(userFile(), 'utf8')).toBe(original);
  });

  it('project scope writes settings.local.json only; the shared settings.json stays byte-identical', () => {
    const shared = readFixture('settings/project-shared-foreign.json');
    put(sharedFile(), shared);
    const r = installHook({ ctx: t.ctx, scope: 'project', command: CMD });
    expect(r.file).toBe(localFile());
    expect(fs.readFileSync(sharedFile(), 'utf8')).toBe(shared);
    expect(findMarkerHandlers(JSON.parse(fs.readFileSync(localFile(), 'utf8')))).toHaveLength(1);
    uninstallHook({ ctx: t.ctx, scope: 'project' });
    expect(fs.readFileSync(sharedFile(), 'utf8')).toBe(shared);
    expect(JSON.parse(fs.readFileSync(localFile(), 'utf8'))).toEqual({});
  });

  it('local file with old markers is upgraded in place with foreign handlers deep-equal', () => {
    put(localFile(), readFixture('settings/local-with-v0-and-duplicate-markers.json'));
    installHook({ ctx: t.ctx, scope: 'project', command: CMD });
    const json = JSON.parse(fs.readFileSync(localFile(), 'utf8'));
    expect(findMarkerHandlers(json)).toHaveLength(1);
    expect(json.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: 'echo foreign-before' });
  });

  it('uninstall --scope all removes markers from user, project-local and project-shared', () => {
    put(sharedFile(), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `x ${'--ai-unlocked-hook=v1'}` }, { type: 'command', command: 'keep-me' }] }] } }));
    installHook({ ctx: t.ctx, scope: 'user', command: CMD });
    installHook({ ctx: t.ctx, scope: 'project', command: CMD });
    const { results, errors } = uninstallHook({ ctx: t.ctx, scope: 'all' });
    expect(errors).toEqual([]);
    expect(results.filter((r) => r.changed)).toHaveLength(3);
    for (const f of [userFile(), localFile(), sharedFile()]) expect(findMarkerHandlers(JSON.parse(fs.readFileSync(f, 'utf8')))).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(sharedFile(), 'utf8')).hooks.Stop[0].hooks).toEqual([{ type: 'command', command: 'keep-me' }]);
  });

  it('invalid JSON aborts without writing anything', () => {
    const text = readFixture('settings/invalid-with-comment.json');
    put(userFile(), text);
    expect(() => installHook({ ctx: t.ctx, scope: 'user', command: CMD })).toThrow(/không phải JSON hợp lệ/);
    expect(fs.readFileSync(userFile(), 'utf8')).toBe(text);
    expect(fs.existsSync(`${userFile()}.ai-unlocked.bak`)).toBe(false);
    expect(fs.existsSync(`${userFile()}.ai-unlocked.tmp`)).toBe(false);
  });

  it('--dry-run returns a diff and writes nothing', () => {
    const text = readFixture('settings/user-with-foreign-hooks.json');
    put(userFile(), text);
    const r = installHook({ ctx: t.ctx, scope: 'user', command: CMD, dryRun: true });
    expect(r.changed).toBe(true);
    expect(r.diff).toContain('--ai-unlocked-hook=v1');
    expect(fs.readFileSync(userFile(), 'utf8')).toBe(text);
    expect(fs.readdirSync(path.dirname(userFile()))).toEqual(['settings.json']);
  });

  it('a failed rename restores the backup and leaves no temp file', () => {
    const text = readFixture('settings/user-with-foreign-hooks.json');
    put(userFile(), text);
    const io = { renameSync: () => { throw Object.assign(new Error('EXDEV: simulated'), { code: 'EXDEV' }); } };
    expect(() => applyToFile(userFile(), (j) => planInstall(j, CMD), { io })).toThrow(/khôi phục/);
    expect(fs.readFileSync(userFile(), 'utf8')).toBe(text);
    expect(fs.existsSync(`${userFile()}.ai-unlocked.tmp`)).toBe(false);
    expect(fs.existsSync(`${userFile()}.ai-unlocked.bak`)).toBe(false);
  });

  it('a verified project-scope write leaves no backup or temp file next to settings.local.json', () => {
    put(localFile(), '{\n  "env": { "SECRET_TOKEN": "keep-local" }\n}\n');
    const r = installHook({ ctx: t.ctx, scope: 'project', command: CMD });
    expect(r.changed).toBe(true);
    expect(fs.readdirSync(path.dirname(localFile())).sort()).toEqual(['settings.local.json']);
  });

  it('keeps the backup only when the rollback itself fails', () => {
    const text = readFixture('settings/user-with-foreign-hooks.json');
    put(userFile(), text);
    let copies = 0;
    const io = {
      renameSync: () => { throw new Error('simulated rename failure'); },
      // The first copy makes the backup; the restore copy fails.
      copyFileSync: (from: fs.PathLike, to: fs.PathLike) => {
        copies += 1;
        if (copies > 1) throw new Error('simulated restore failure');
        fs.copyFileSync(from, to);
      },
    };
    expect(() => applyToFile(userFile(), (j) => planInstall(j, CMD), { io })).toThrow(/không khôi phục được/);
    expect(fs.readFileSync(`${userFile()}.ai-unlocked.bak`, 'utf8')).toBe(text);
  });

  it('project uninstall removes backup and temp files left by an older CLI, but not for user scope', () => {
    installHook({ ctx: t.ctx, scope: 'project', command: CMD });
    put(userFile(), '{}\n');
    const leftovers = [`${localFile()}.ai-unlocked.bak`, `${localFile()}.ai-unlocked.tmp`, `${sharedFile()}.ai-unlocked.bak`];
    for (const f of [...leftovers, `${userFile()}.ai-unlocked.bak`]) put(f, '{"env":{"K":"v"}}');
    const dry = uninstallHook({ ctx: t.ctx, scope: 'project', dryRun: true });
    expect(dry.removedLeftovers).toEqual([]);
    for (const f of leftovers) expect(fs.existsSync(f)).toBe(true);
    const r = uninstallHook({ ctx: t.ctx, scope: 'project' });
    expect(r.errors).toEqual([]);
    expect([...r.removedLeftovers].sort()).toEqual([...leftovers].sort());
    for (const f of leftovers) expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(`${userFile()}.ai-unlocked.bak`)).toBe(true);
  });

  it('a corrupted write (re-read mismatch) is rolled back to the original', () => {
    const text = readFixture('settings/project-shared-foreign.json');
    put(localFile(), text);
    const io = {
      renameSync: (from: fs.PathLike, to: fs.PathLike) => { fs.renameSync(from, to); fs.writeFileSync(to, '{"broken": true}'); },
    };
    expect(() => applyToFile(localFile(), (j) => planInstall(j, CMD), { io })).toThrow(SettingsError);
    expect(fs.readFileSync(localFile(), 'utf8')).toBe(text);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a permission-denied directory leaves the original untouched', () => {
    const text = readFixture('settings/user-with-foreign-hooks.json');
    put(userFile(), text);
    const dir = path.dirname(userFile());
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => installHook({ ctx: t.ctx, scope: 'user', command: CMD })).toThrow(SettingsError);
      expect(fs.readFileSync(userFile(), 'utf8')).toBe(text);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('a new file that fails to write is removed again (no half-created settings)', () => {
    const io = { renameSync: () => { throw new Error('simulated'); } };
    expect(() => applyToFile(userFile(), (j) => planInstall(j, CMD), { io })).toThrow(SettingsError);
    expect(fs.existsSync(userFile())).toBe(false);
  });

  it('keeps the original file mode and tab indentation', () => {
    put(userFile(), '{\n\t"model": "x"\n}\n');
    fs.chmodSync(userFile(), 0o600);
    installHook({ ctx: t.ctx, scope: 'user', command: CMD });
    expect(fs.statSync(userFile()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(userFile(), 'utf8')).toMatch(/^\{\n\t"model"/);
  });
});
