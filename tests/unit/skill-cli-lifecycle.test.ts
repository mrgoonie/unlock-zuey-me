/**
 * ai-unlocked CLI end to end against a temp HOME + temp project: hook install/uninstall per scope, dry-run,
 * pause/resume, status never printing the token, uninstall --purge revoking the token, doctor --json, and the
 * device pairing loop (in-process, with an injected sleep so slow_down never costs wall time).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairDevice } from '../../skills/ai-unlocked/scripts/lib/pairing.mjs';
import {
  configFiles, makeTempEnv, readFixture, runNode, SCRIPTS_DIR, startFakeServer, TEST_TOKEN, writeCredentialsFile, writeStateFile,
  type FakeReply, type FakeServer, type TempEnv,
} from '../fixtures/skill/skill-test-helpers';

const CLI = path.join(SCRIPTS_DIR, 'ai-unlocked.mjs');
const HOOK_SCRIPT = path.join(SCRIPTS_DIR, 'stop-hook.mjs');

describe('ai-unlocked CLI', () => {
  let t: TempEnv;
  let server: FakeServer;
  beforeEach(async () => {
    t = makeTempEnv();
    server = await startFakeServer();
  });
  afterEach(async () => { await server.close(); t.cleanup(); });

  const cli = (...args: string[]) => runNode(CLI, args, { env: t.spawnEnv({ AI_UNLOCKED_SERVER: server.url }), cwd: t.cwd });
  const userSettings = () => path.join(t.home, '.claude', 'settings.json');
  const localSettings = () => path.join(t.cwd, '.claude', 'settings.local.json');
  const sharedSettings = () => path.join(t.cwd, '.claude', 'settings.json');
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

  it('user scope: install keeps foreign hooks, is idempotent, and uninstall restores the foreign content', async () => {
    const foreign = readFixture('settings/user-with-foreign-hooks.json');
    write(userSettings(), foreign);

    const dry = await cli('hook', 'install', '--scope', 'user', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('--dry-run');
    expect(dry.stdout).toContain('+');
    expect(fs.readFileSync(userSettings(), 'utf8')).toBe(foreign);

    const first = await cli('hook', 'install', '--scope', 'user');
    expect(first.code).toBe(0);
    const installed = JSON.parse(fs.readFileSync(userSettings(), 'utf8'));
    const commands = JSON.stringify(installed.hooks.Stop);
    expect(commands).toContain(HOOK_SCRIPT);
    expect(commands).toContain('--ai-unlocked-hook=v1');
    expect(fs.existsSync(`${userSettings()}.ai-unlocked.bak`)).toBe(true);
    const afterFirst = fs.readFileSync(userSettings(), 'utf8');

    const second = await cli('hook', 'install', '--scope', 'user');
    expect(second.code).toBe(0);
    expect(fs.readFileSync(userSettings(), 'utf8')).toBe(afterFirst);

    expect((await cli('hook', 'uninstall', '--scope', 'user')).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(userSettings(), 'utf8'))).toEqual(JSON.parse(foreign));
  });

  it('project scope writes settings.local.json only; uninstall also cleans a marker copied into the shared file', async () => {
    const shared = readFixture('settings/project-shared-foreign.json');
    write(sharedSettings(), shared);
    expect((await cli('hook', 'install', '--scope', 'project')).code).toBe(0);
    expect(fs.readFileSync(sharedSettings(), 'utf8')).toBe(shared);
    expect(fs.readFileSync(localSettings(), 'utf8')).toContain('--ai-unlocked-hook=v1');
    expect(fs.existsSync(userSettings())).toBe(false);

    const copied = JSON.parse(shared);
    copied.hooks.Stop = [...(copied.hooks.Stop ?? []), { hooks: [{ type: 'command', command: `"node" "${HOOK_SCRIPT}" --ai-unlocked-hook=v1` }] }];
    write(sharedSettings(), JSON.stringify(copied, null, 2));
    expect((await cli('hook', 'uninstall', '--scope', 'project')).code).toBe(0);
    expect(fs.readFileSync(localSettings(), 'utf8')).not.toContain('ai-unlocked-hook');
    expect(JSON.parse(fs.readFileSync(sharedSettings(), 'utf8'))).toEqual(JSON.parse(shared));
  });

  it('invalid settings JSON aborts install without writing', async () => {
    const invalid = readFixture('settings/invalid-with-comment.json');
    write(userSettings(), invalid);
    const r = await cli('hook', 'install', '--scope', 'user');
    expect(r.code).toBe(1);
    expect(fs.readFileSync(userSettings(), 'utf8')).toBe(invalid);
    expect(fs.existsSync(`${userSettings()}.ai-unlocked.bak`)).toBe(false);
  });

  it('rejects a missing or unknown --scope', async () => {
    expect((await cli('hook', 'install')).code).toBe(1);
    expect((await cli('hook', 'install', '--scope', 'everywhere')).code).toBe(1);
    expect((await cli('nope')).code).toBe(1);
  });

  it('pause/resume toggle local state; status reports pairing without ever printing the token', async () => {
    writeCredentialsFile(t, server.url);
    expect((await cli('pause')).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFiles(t).state, 'utf8')).paused).toBe(true);
    const paused = await cli('status');
    expect(paused.stdout).toContain('tạm dừng');
    expect(paused.stdout).toContain('…abcd');
    expect(paused.stdout).not.toContain(TEST_TOKEN);
    expect((await cli('resume')).code).toBe(0);
    expect((await cli('status')).stdout).toContain('đang bật');
    expect(server.requests).toEqual([]);
  });

  it('uninstall --purge removes hooks, revokes the token via DELETE /token and deletes the config dir', async () => {
    writeCredentialsFile(t, server.url);
    writeStateFile(t, { paused: true });
    server.setResponder(() => ({ status: 200, body: { revoked: true } }));
    expect((await cli('hook', 'install', '--scope', 'user')).code).toBe(0);
    const r = await cli('uninstall', '--purge');
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(TEST_TOKEN);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: 'DELETE', url: '/api/ingest/v1/token' });
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(fs.existsSync(configFiles(t).dir)).toBe(false);
    expect(fs.readFileSync(userSettings(), 'utf8')).not.toContain('ai-unlocked-hook');
    // The repo copy of the skill is not an install location, so it is never deleted.
    expect(fs.existsSync(CLI)).toBe(true);
  });

  it('doctor --json --offline reports structured checks without network', async () => {
    writeCredentialsFile(t, server.url);
    writeStateFile(t, { paused: true, parser: 'degraded' });
    write(userSettings(), JSON.stringify({ disableAllHooks: true }));
    const r = await cli('doctor', '--json', '--offline');
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout) as { version: string; checks: Array<{ group: string; name: string; level: string; detail: string }> };
    const find = (group: string, name: string) => report.checks.filter((c) => c.group === group && c.name === name);
    expect(find('runtime', 'node')[0].level).toBe('ok');
    expect(find('settings', 'user')[0]).toMatchObject({ level: 'fail' });
    expect(find('local', 'paused')[0].level).toBe('warn');
    expect(find('local', 'parser')[0].level).toBe('warn');
    expect(r.stdout).not.toContain(TEST_TOKEN);
    expect(server.requests).toEqual([]);
  });

  it('doctor online checks the manifest version and consent', async () => {
    writeCredentialsFile(t, server.url);
    server.setResponder((req) => (req.url === '/skill/manifest.json'
      ? { status: 200, body: { name: 'ai-unlocked', version: '9.0.0', files: [] } }
      : { status: 200, body: { feature: true, consents: { analysis: false } } }));
    const r = await cli('doctor', '--json');
    const checks = JSON.parse(r.stdout).checks as Array<{ group: string; name: string; level: string; detail: string }>;
    expect(checks.find((c) => c.name === 'version')).toMatchObject({ level: 'warn' });
    expect(checks.find((c) => c.name === 'consent')).toMatchObject({ level: 'warn' });
    expect(server.requests.map((q) => q.url).sort()).toEqual(['/api/ingest/v1/status', '/skill/manifest.json']);
  });
});

describe('pairDevice', () => {
  let t: TempEnv;
  let server: FakeServer;
  const DEVICE_CODE = 'D'.repeat(43);
  const start: FakeReply = { status: 200, body: { deviceCode: DEVICE_CODE, userCode: 'ABCD-EFGH', verificationUri: 'https://unlock.zuey.me/pair', interval: 5, expiresIn: 600 } };
  beforeEach(async () => {
    t = makeTempEnv();
    server = await startFakeServer();
  });
  afterEach(async () => { await server.close(); t.cleanup(); });

  const pair = (sleeps: number[], lines: string[] = []) =>
    pairDevice({ paths: configFiles(t), server: server.url, label: 'test', print: (l: string) => lines.push(l), sleep: async (ms: number) => { sleeps.push(ms); } });

  it('428 → 429 slow_down (+5 s) → 200 stores the token at 0600 and never prints it', async () => {
    const polls: FakeReply[] = [
      { status: 428, body: { error: { code: 'x', message: 'x', reason: 'authorization_pending' } } },
      { status: 429, body: { error: { code: 'x', message: 'x', reason: 'slow_down' } } },
      { status: 200, body: { token: TEST_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z' } },
    ];
    server.setResponder((req) => (req.url.endsWith('/pair/start') ? start : polls.shift() as FakeReply));
    const sleeps: number[] = [];
    const lines: string[] = [];
    const r = await pair(sleeps, lines);
    expect(r.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    expect(sleeps).toEqual([5000, 5000, 10_000]);
    expect(lines.join('\n')).toContain('ABCD-EFGH');
    expect(lines.join('\n')).not.toContain(TEST_TOKEN);
    const credFile = configFiles(t).credentials;
    expect(JSON.parse(fs.readFileSync(credFile, 'utf8')).token).toBe(TEST_TOKEN);
    expect(fs.statSync(credFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(server.requests[0].body)).toEqual({ label: 'test', adapter: 'claude-code' });
    expect(JSON.parse(server.requests[1].body)).toEqual({ deviceCode: DEVICE_CODE });
  });

  it('enforces a 5 s minimum poll interval even when the server says less', async () => {
    server.setResponder((req) => (req.url.endsWith('/pair/start')
      ? { ...start, body: { ...(start.body as object), interval: 1 } }
      : { status: 200, body: { token: TEST_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z' } }));
    const sleeps: number[] = [];
    await pair(sleeps);
    expect(sleeps).toEqual([5000]);
  });

  it.each([
    ['denied', /từ chối/],
    ['expired', /hết hạn/],
  ])('410 %s fails without writing credentials', async (status, message) => {
    server.setResponder((req) => (req.url.endsWith('/pair/start') ? start : { status: 410, body: { status } }));
    await expect(pair([])).rejects.toThrow(message);
    expect(fs.existsSync(configFiles(t).credentials)).toBe(false);
  });

  it('rejects malformed start data and a malformed token', async () => {
    server.setResponder(() => ({ ...start, body: { ...(start.body as object), verificationUri: 'javascript:alert(1)' } }));
    await expect(pair([])).rejects.toThrow(/không hợp lệ/);
    server.setResponder((req) => (req.url.endsWith('/pair/start') ? start : { status: 200, body: { token: 'nope' } }));
    await expect(pair([])).rejects.toThrow(/token không hợp lệ/);
    expect(fs.existsSync(configFiles(t).credentials)).toBe(false);
  });

  it('404 on start explains the feature is off', async () => {
    server.setResponder(() => ({ status: 404, body: { error: { code: 'not_found', message: 'x', reason: 'feature_off' } } }));
    await expect(pair([])).rejects.toThrow(/chưa bật/);
  });
});
