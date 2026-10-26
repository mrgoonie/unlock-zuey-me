/**
 * The Stop hook must not slow a turn down: with a ~300 KB transcript and the ingest server answering after 5 s, 40 spawned hook runs have
 * p95 wall time < 250 ms (node start-up included), exit 0 and print nothing. Upload happens in the detached
 * uploader; once the server is fast again the spool drains and the lock is released.
 * SKILL_HOOK_P95_MS overrides the budget on slow CI machines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configFiles, fixture, killUploader, makeTempEnv, runNode, SCRIPTS_DIR, spoolFiles, startFakeServer, stopPayload, waitFor,
  writeCredentialsFile, type FakeServer, type TempEnv,
} from '../fixtures/skill/skill-test-helpers';

const RUNS = 40;
const P95_BUDGET_MS = Number(process.env.SKILL_HOOK_P95_MS) || 250;

describe('stop hook overhead', () => {
  let t: TempEnv;
  let server: FakeServer;
  beforeAll(async () => {
    t = makeTempEnv();
    server = await startFakeServer(() => ({ status: 202, body: { accepted: true, duplicate: false }, delayMs: 5000 }));
    writeCredentialsFile(t, server.url);
  });
  afterAll(async () => {
    killUploader(t);
    await server.close();
    t.cleanup();
  });

  it(`p95 < ${P95_BUDGET_MS} ms over ${RUNS} runs with a 5 s server`, { retry: 1, timeout: 120_000 }, async () => {
    // ~300 KB transcript: earlier turns (filler) followed by the recorded mission turn.
    const transcript = path.join(t.root, 'transcript-300kb.jsonl');
    const filler = `${JSON.stringify({ type: 'attachment', attachment: { type: 'file', content: 'x'.repeat(1000) } })}\n`;
    fs.writeFileSync(transcript, filler.repeat(300) + fs.readFileSync(fixture('transcripts/claude-code-2.1.304-mission-turn.jsonl'), 'utf8'));
    expect(fs.statSync(transcript).size).toBeGreaterThan(300_000);
    const durations: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const stdin = JSON.stringify(stopPayload('stop.json', transcript, { prompt_id: `prompt-${i}`, last_assistant_message: `Lượt ${i}` }));
      const r = await runNode(path.join(SCRIPTS_DIR, 'stop-hook.mjs'), ['--ai-unlocked-hook=v1'], { env: t.spawnEnv(), cwd: t.cwd, stdin });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      durations.push(r.ms);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(RUNS * 0.95) - 1];
    expect(p95, `durations: ${durations.map((d) => d.toFixed(0)).join(',')}`).toBeLessThan(P95_BUDGET_MS);

    // The single uploader is still waiting on the slow server; make it fast and let the spool drain.
    server.setResponder(() => ({ status: 202, body: { accepted: true, duplicate: false } }));
    expect(await waitFor(() => spoolFiles(t).length === 0 && !fs.existsSync(configFiles(t).flushLock), 60_000)).toBe(true);
    expect(new Set(server.requests.map((q) => JSON.parse(q.body).idempotencyKey)).size).toBe(RUNS);
  });
});
