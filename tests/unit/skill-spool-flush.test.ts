/** Spool caps and the uploader's per-status behaviour (docs/insights-ingest-contract.md "Hook behaviour" column). */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSpool } from '../../skills/ai-unlocked/scripts/lib/flush-runner.mjs';
import { readState } from '../../skills/ai-unlocked/scripts/lib/local-state.mjs';
import { runStopHook } from '../../skills/ai-unlocked/scripts/lib/stop-hook-core.mjs';
import { acquireFlushLock, enforceSpoolCaps, writeSpoolItem } from '../../skills/ai-unlocked/scripts/lib/spool.mjs';
import {
  configFiles, fixture, makeTempEnv, spoolFiles, startFakeServer, stopPayload, writeCredentialsFile,
  type FakeReply, type FakeServer, type TempEnv,
} from '../fixtures/skill/skill-test-helpers';

const hex = (n: number) => n.toString(16).padStart(64, '0');
const payload = (n: number): { idempotencyKey: string; [key: string]: unknown } => ({ v: 1, idempotencyKey: hex(n), sentAt: '2000-01-01T00:00:00.000Z', turn: { assistantFinal: `t${n}` } });
const err = (status: number, reason: string): FakeReply => ({ status, body: { error: { code: 'x', message: 'x', reason } } });

describe('flushSpool', () => {
  let t: TempEnv;
  let server: FakeServer;
  let paths: ReturnType<typeof configFiles>;
  beforeEach(async () => {
    t = makeTempEnv();
    server = await startFakeServer();
    paths = configFiles(t);
    writeCredentialsFile(t, server.url);
  });
  afterEach(async () => { await server.close(); t.cleanup(); });

  const spool = (...ns: number[]) => ns.forEach((n, i) => writeSpoolItem(paths, payload(n), Date.now() - (ns.length - i) * 1000));

  it('202 deletes every item, oldest first, with a fresh sentAt', async () => {
    spool(1, 2, 3);
    const r = await flushSpool(paths, t.ctx.env);
    expect(r).toMatchObject({ uploaded: 3, stopped: null });
    expect(spoolFiles(t)).toEqual([]);
    const bodies = server.requests.map((q) => JSON.parse(q.body));
    expect(bodies.map((b) => b.turn.assistantFinal)).toEqual(['t1', 't2', 't3']);
    expect(Math.abs(Date.parse(bodies[0].sentAt) - Date.now())).toBeLessThan(60_000);
    expect(fs.existsSync(paths.flushLock)).toBe(false);
  });

  it('400 drops the item; clock_skew is retried once with a rebuilt sentAt', async () => {
    let calls = 0;
    server.setResponder(() => (++calls === 1 ? err(400, 'clock_skew') : calls === 2 ? { status: 202 } : err(400, 'invalid_payload')));
    spool(1, 2);
    const r = await flushSpool(paths, t.ctx.env);
    expect(r).toMatchObject({ uploaded: 1, dropped: 1 });
    expect(server.requests).toHaveLength(3);
    expect(spoolFiles(t)).toEqual([]);
  });

  it('401 marks credentials invalid, keeps the spool and stops; the hook then captures nothing', async () => {
    server.setResponder(() => err(401, 'unauthorized'));
    spool(1, 2);
    const r = await flushSpool(paths, t.ctx.env);
    expect(r.stopped).toBe('unauthorized');
    expect(server.requests).toHaveLength(1);
    expect(spoolFiles(t)).toHaveLength(2);
    expect(readState(paths).credentialsInvalid).toBe(true);
    expect(runStopHook(stopPayload('stop.json', fixture('transcripts/garbage.jsonl')), { ctx: t.ctx }).outcome).toBe('credentials_invalid');
    expect((await flushSpool(paths, t.ctx.env)).skipped).toBe('credentials_invalid');
    expect(server.requests).toHaveLength(1);
  });

  it('403 consent_required deletes the spool, backs off 24 h and makes no further POSTs', async () => {
    server.setResponder(() => err(403, 'consent_required'));
    spool(1, 2, 3);
    const r = await flushSpool(paths, t.ctx.env);
    expect(r.stopped).toBe('consent_required');
    expect(spoolFiles(t)).toEqual([]);
    const state = readState(paths);
    expect(state.serverBlockedUntil - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(state.blockReason).toBe('consent_required');
    spool(4);
    expect((await flushSpool(paths, t.ctx.env)).skipped).toBe('server_blocked');
    expect(runStopHook(stopPayload('stop.json', fixture('transcripts/garbage.jsonl')), { ctx: t.ctx }).outcome).toBe('server_blocked');
    expect(server.requests).toHaveLength(1);
  });

  it('403 origin_forbidden drops only that item', async () => {
    let calls = 0;
    server.setResponder(() => (++calls === 1 ? err(403, 'origin_forbidden') : { status: 202 }));
    spool(1, 2);
    expect(await flushSpool(paths, t.ctx.env)).toMatchObject({ uploaded: 1, dropped: 1, stopped: null });
  });

  it('404 feature_off deletes the spool and backs off 24 h', async () => {
    server.setResponder(() => err(404, 'feature_off'));
    spool(1, 2);
    expect((await flushSpool(paths, t.ctx.env)).stopped).toBe('feature_off');
    expect(spoolFiles(t)).toEqual([]);
    expect(readState(paths).serverBlockedUntil).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });

  it('429 daily_cap keeps the spool and waits until 00:00 UTC; the hook keeps spooling', async () => {
    server.setResponder(() => err(429, 'daily_cap'));
    spool(1);
    expect((await flushSpool(paths, t.ctx.env)).stopped).toBe('daily_cap');
    const state = readState(paths);
    expect(new Date(state.uploadRetryAfter).getUTCHours()).toBe(0);
    expect(state.uploadRetryAfter).toBeGreaterThan(Date.now());
    expect(spoolFiles(t)).toHaveLength(1);
    expect((await flushSpool(paths, t.ctx.env)).skipped).toBe('retry_later');
    const hook = runStopHook(stopPayload('stop.json', fixture('transcripts/garbage.jsonl')), { ctx: t.ctx });
    expect(hook).toMatchObject({ outcome: 'spooled', spawnFlush: false });
  });

  it.each([
    ['429 rate_limited', err(429, 'rate_limited')],
    ['503', { status: 503 } as FakeReply],
  ])('%s keeps the spool and stops', async (_label, reply) => {
    server.setResponder(() => reply);
    spool(1, 2);
    expect((await flushSpool(paths, t.ctx.env)).stopped).toBe('retry_later');
    expect(server.requests).toHaveLength(1);
    expect(spoolFiles(t)).toHaveLength(2);
  });

  it('a timeout keeps the spool', async () => {
    server.setResponder(() => ({ status: 202, hang: true }));
    spool(1);
    expect((await flushSpool(paths, t.ctx.env, { timeoutMs: 200 })).stopped).toBe('retry_later');
    expect(spoolFiles(t)).toHaveLength(1);
    expect(fs.readFileSync(paths.log, 'utf8')).toMatch(/ network \d+ms/);
  });

  it('a live lock skips; a lock left by a killed uploader is recovered after 60 s', async () => {
    spool(1);
    expect(acquireFlushLock(paths)).toBe(true);
    fs.writeFileSync(paths.flushLock, JSON.stringify({ pid: 999_999_999 }));
    expect((await flushSpool(paths, t.ctx.env)).skipped).toBe('locked');
    const past = new Date(Date.now() - 61_000);
    fs.utimesSync(paths.flushLock, past, past);
    expect(await flushSpool(paths, t.ctx.env)).toMatchObject({ uploaded: 1 });
    expect(fs.existsSync(paths.flushLock)).toBe(false);
  });

  it('pause blocks network entirely', async () => {
    spool(1);
    fs.writeFileSync(paths.state, JSON.stringify({ paused: true }));
    expect((await flushSpool(paths, t.ctx.env)).skipped).toBe('paused');
    expect(server.requests).toEqual([]);
  });
});

describe('spool caps', () => {
  let t: TempEnv;
  beforeEach(() => { t = makeTempEnv(); });
  afterEach(() => t.cleanup());

  it('keeps at most 50 files (oldest dropped), drops > 24 h, and stays under 1 MB', () => {
    const paths = configFiles(t);
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      const file = writeSpoolItem(paths, payload(i), now);
      const at = new Date(now - (60 - i) * 1000);
      fs.utimesSync(file, at, at);
    }
    enforceSpoolCaps(paths, now);
    expect(spoolFiles(t)).toHaveLength(50);
    expect(spoolFiles(t)).not.toContain(`${hex(0)}.json`);

    const old = path.join(paths.spool, `${hex(15)}.json`);
    const dayAgo = new Date(now - 25 * 3600_000);
    fs.utimesSync(old, dayAgo, dayAgo);
    enforceSpoolCaps(paths, now);
    expect(fs.existsSync(old)).toBe(false);

    const big = 'x'.repeat(30_000);
    for (let i = 100; i < 140; i++) writeSpoolItem(paths, { ...payload(i), turn: { assistantFinal: big } }, now);
    const total = spoolFiles(t).reduce((s, f) => s + fs.statSync(path.join(paths.spool, f)).size, 0);
    expect(total).toBeLessThanOrEqual(1024 * 1024);
    for (const f of spoolFiles(t)) expect(fs.statSync(path.join(paths.spool, f)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.spool).mode & 0o777).toBe(0o700);
  });
});
