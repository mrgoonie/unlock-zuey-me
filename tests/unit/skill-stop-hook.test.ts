/**
 * Stop hook: always exit 0 with empty stdout, never capture subagents or internal processes, read nothing without
 * credentials, and never let a secret reach the spool or the wire.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStopHook } from '../../skills/ai-unlocked/scripts/lib/stop-hook-core.mjs';
import {
  configFiles, fixture, killUploader, makeTempEnv, runNode, SCRIPTS_DIR, spoolFiles, startFakeServer, stopPayload,
  TEST_TOKEN, waitFor, writeCredentialsFile, writeStateFile, type FakeServer, type TempEnv,
} from '../fixtures/skill/skill-test-helpers';

const HOOK = path.join(SCRIPTS_DIR, 'stop-hook.mjs');
const MISSION = fixture('transcripts/claude-code-2.1.304-mission-turn.jsonl');
const SECRETS = fixture('transcripts/prompt-with-secrets.jsonl');

describe('stop-hook.mjs (spawned)', () => {
  let t: TempEnv;
  let server: FakeServer;
  beforeEach(async () => {
    t = makeTempEnv();
    server = await startFakeServer();
  });
  afterEach(async () => {
    await waitFor(() => !fs.existsSync(configFiles(t).flushLock), 10_000);
    killUploader(t);
    await server.close();
    t.cleanup();
  });

  const run = (stdin: string, extra: Record<string, string> = {}) =>
    runNode(HOOK, ['--ai-unlocked-hook=v1'], { env: t.spawnEnv(extra), cwd: t.cwd, stdin });

  const expectSilentSuccess = (r: { code: number | null; stdout: string; stderr: string }) => {
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  };

  it('garbage, empty and oversized stdin exit 0 silently', async () => {
    writeCredentialsFile(t, server.url);
    for (const stdin of ['not json', '', '[1,2]', 'x'.repeat(1_100_000)]) expectSilentSuccess(await run(stdin));
    expect(spoolFiles(t)).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it('SubagentStop and Stop payloads with agent_id are ignored (no spool, no network)', async () => {
    writeCredentialsFile(t, server.url);
    expectSilentSuccess(await run(JSON.stringify(stopPayload('subagent-stop.json', MISSION))));
    expectSilentSuccess(await run(JSON.stringify(stopPayload('stop-with-agent-id.json', MISSION))));
    expect(spoolFiles(t)).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it('AI_UNLOCKED_INTERNAL=1 exits immediately without spooling', async () => {
    writeCredentialsFile(t, server.url);
    expectSilentSuccess(await run(JSON.stringify(stopPayload('stop.json', MISSION)), { AI_UNLOCKED_INTERNAL: '1' }));
    expect(spoolFiles(t)).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it('paused or unpaired: exit 0, nothing spooled, no request', async () => {
    expectSilentSuccess(await run(JSON.stringify(stopPayload('stop.json', MISSION))));
    writeCredentialsFile(t, server.url);
    writeStateFile(t, { paused: true });
    expectSilentSuccess(await run(JSON.stringify(stopPayload('stop.json', MISSION))));
    expect(spoolFiles(t)).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it('happy path spools a 0600 file and the detached uploader posts it without leaking secrets', async () => {
    writeCredentialsFile(t, server.url);
    const r = await run(JSON.stringify(stopPayload('stop.json', SECRETS, { last_assistant_message: 'token sk-proj-QQQQQQQQQQQQQQQQQQQQ9999' })));
    expectSilentSuccess(r);
    expect(await waitFor(() => server.requests.length === 1 && spoolFiles(t).length === 0, 10_000)).toBe(true);
    const req = server.requests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/ingest/v1/turns');
    expect(req.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(req.headers.origin).toBeUndefined();
    for (const secret of ['sk-ant-api03', 'ghp_AbCd', 'sk-proj-QQQQ', '/Users/learner', '5f0c2b9e-1111']) expect(req.body).not.toContain(secret);
    expect(JSON.parse(req.body).turn.userPrompt).toContain('[REDACTED:');
    const log = fs.readFileSync(configFiles(t).log, 'utf8');
    expect(log).toMatch(/^\S+ 202 \d+ms\n$/);
    expect(log).not.toContain(TEST_TOKEN);
  });

  it('server 500 keeps the spool; exit stays 0 and silent', async () => {
    server.setResponder(() => ({ status: 500, body: { error: { code: 'internal', message: 'x' } } }));
    writeCredentialsFile(t, server.url);
    expectSilentSuccess(await run(JSON.stringify(stopPayload('stop.json', MISSION))));
    expect(await waitFor(() => server.requests.length === 1 && !fs.existsSync(configFiles(t).flushLock), 10_000)).toBe(true);
    expect(spoolFiles(t)).toHaveLength(1);
    expect(fs.statSync(path.join(configFiles(t).spool, spoolFiles(t)[0])).mode & 0o777).toBe(0o600);
  });

  it('a hanging server never delays the hook', async () => {
    server.setResponder(() => ({ status: 202, hang: true }));
    writeCredentialsFile(t, server.url);
    const r = await run(JSON.stringify(stopPayload('stop.json', MISSION)));
    expectSilentSuccess(r);
    expect(r.ms).toBeLessThan(1500);
    expect(await waitFor(() => server.requests.length === 1, 5_000)).toBe(true);
    killUploader(t);
    fs.rmSync(configFiles(t).flushLock, { force: true }); // a SIGKILLed uploader cannot release its lock
    expect(spoolFiles(t)).toHaveLength(1);
  });
});

describe('runStopHook (in-process)', () => {
  let t: TempEnv;
  beforeEach(() => { t = makeTempEnv(); });
  afterEach(() => { vi.restoreAllMocks(); t.cleanup(); });

  it('never opens the transcript without credentials', () => {
    const openSpy = vi.spyOn(fs, 'openSync');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const r = runStopHook(stopPayload('stop.json', MISSION), { ctx: t.ctx });
    expect(r.outcome).toBe('no_credentials');
    const touched = [...openSpy.mock.calls, ...readSpy.mock.calls].map((c) => String(c[0]));
    expect(touched.some((p) => p.endsWith('.jsonl'))).toBe(false);
  });

  it('never opens the transcript while paused, blocked or after a 401', () => {
    writeCredentialsFile(t, 'http://127.0.0.1:9');
    const openSpy = vi.spyOn(fs, 'openSync');
    for (const [state, outcome] of [
      [{ paused: true }, 'paused'],
      [{ serverBlockedUntil: Date.now() + 60_000 }, 'server_blocked'],
      [{ credentialsInvalid: true }, 'credentials_invalid'],
    ] as const) {
      writeStateFile(t, state);
      expect(runStopHook(stopPayload('stop.json', MISSION), { ctx: t.ctx }).outcome).toBe(outcome);
    }
    expect(openSpy.mock.calls.map((c) => String(c[0])).some((p) => p.endsWith('.jsonl'))).toBe(false);
  });

  it('stop_hook_active re-fire keeps the idempotency key and replaces the pending spool file', () => {
    writeCredentialsFile(t, 'http://127.0.0.1:9');
    const first = runStopHook(stopPayload('stop.json', MISSION), { ctx: t.ctx });
    const refire = runStopHook(stopPayload('stop.json', MISSION, { stop_hook_active: true, last_assistant_message: 'Sau khi hook khác chặn.' }), { ctx: t.ctx });
    expect(first.outcome).toBe('spooled');
    expect(refire.file).toBe(first.file);
    expect(spoolFiles(t)).toHaveLength(1);
    const stored = JSON.parse(fs.readFileSync(refire.file as string, 'utf8')).payload;
    expect(stored.stopHookActive).toBe(true);
    expect(stored.turn.assistantFinal).toBe('Sau khi hook khác chặn.');
  });

  it('records parser degradation for doctor and still spools the final reply', () => {
    writeCredentialsFile(t, 'http://127.0.0.1:9');
    const r = runStopHook(stopPayload('stop.json', fixture('transcripts/garbage.jsonl')), { ctx: t.ctx });
    expect(r.outcome).toBe('spooled');
    expect(JSON.parse(fs.readFileSync(configFiles(t).state, 'utf8')).parser).toBe('degraded');
    expect(JSON.parse(fs.readFileSync(r.file as string, 'utf8')).payload.turn.userPrompt).toBeNull();
  });

  it('rejects inputs without a session id or with the wrong event', () => {
    writeCredentialsFile(t, 'http://127.0.0.1:9');
    expect(runStopHook({ hook_event_name: 'Stop' }, { ctx: t.ctx }).outcome).toBe('invalid_input');
    expect(runStopHook({ hook_event_name: 'PreToolUse', session_id: 's' }, { ctx: t.ctx }).outcome).toBe('ignored_event');
    expect(runStopHook(null, { ctx: t.ctx }).outcome).toBe('invalid_input');
  });
});
