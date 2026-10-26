import { describe, expect, it } from 'vitest';
import type { Answers, MissionRun } from '../../src/lib/learning/types';
import { ApiError } from '../../src/lib/ui/api-client';
import { createSaveQueue, type SaveState } from '../../src/lib/ui/autosave-queue';
import { emptyDraft, setField, type RunDraft } from '../../src/lib/ui/run-draft';

const run = (rev: number, answers: Answers = {}): MissionRun => ({
  id: 'run_1', learnerId: 'l', missionId: 'm', missionVersion: 1, status: 'started', currentStep: null, answers, confidence: null,
  hintMaxLevel: 0, hintsUsed: 0, revealed: [], source: 'web', rev, startedAt: '', updatedAt: '', completedAt: null,
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Fake server: enforces rev like the engine, answers after `delayMs`, records every PATCH and the max concurrency. */
function harness(delayMs = 15) {
  let draft: RunDraft = emptyDraft('run_1', 'm');
  let current = run(1);
  let server = run(1);
  const calls: Array<{ stepId: string; rev: number; answers: Answers[string] }> = [];
  const states: SaveState[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const queue = createSaveQueue({
    getDraft: () => draft,
    getRun: () => current,
    setDraft: (d) => { draft = d; },
    setRun: (r) => { current = r; },
    currentStepId: () => 's1',
    onState: (s) => states.push(s),
    save: async (_id, input) => {
      calls.push({ stepId: input.stepId, rev: input.rev, answers: input.answers });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(delayMs);
      inFlight -= 1;
      if (input.rev !== server.rev) throw new ApiError('conflict', 'stale', 409, { error: { code: 'conflict' }, run: server });
      server = run(server.rev + 1, { ...server.answers, [input.stepId]: input.answers });
      return { run: server };
    },
  });
  return {
    queue, calls, states,
    edit: (step: string, field: string, value: string) => { draft = setField(draft, step, field, value); },
    draft: () => draft,
    server: () => server,
    bumpServer: (answers: Answers) => { server = run(server.rev + 1, { ...server.answers, ...answers }); },
    maxInFlight: () => maxInFlight,
  };
}

describe('autosave queue', () => {
  it('serializes rapid edits: one PATCH in flight, increasing rev, edits coalesced', async () => {
    const h = harness();
    h.edit('s1', 'a', '1');
    const p1 = h.queue.flush();
    await tick(1); // first PATCH (rev 1) is now in flight
    expect(h.calls).toHaveLength(1);
    h.edit('s1', 'a', '12');
    const p2 = h.queue.flush();
    h.edit('s1', 'a', '123');
    const p3 = h.queue.flush();
    expect(p3).toBe(p2); // flushes queued behind a running drain share one drain
    expect(h.calls).toHaveLength(1); // nothing new is sent while a PATCH is in flight
    await Promise.all([p1, p2, p3]);
    expect(h.maxInFlight()).toBe(1);
    // The in-flight drain picks up the newer edit itself with the rev from its response; no stale-rev PATCH.
    expect(h.calls.map((c) => c.rev)).toEqual([1, 2]);
    expect(h.calls[0].answers).toEqual({ a: '1' });
    expect(h.calls.at(-1)?.answers).toEqual({ a: '123' });
    expect(h.server().answers.s1).toEqual({ a: '123' });
    expect(h.queue.pending()).toBe(false);
    expect(h.states.at(-1)).toBe('saved');
  });

  it('settle() waits for in-flight and queued saves, including edits made meanwhile', async () => {
    const h = harness(20);
    h.edit('s1', 'a', 'x');
    void h.queue.flush();
    await tick(5);
    h.edit('s2', 'b', 'typed during the save');
    let settled = false;
    const done = h.queue.settle().then((ok) => { settled = true; return ok; });
    await tick(10);
    expect(settled).toBe(false);
    expect(await done).toBe(true);
    expect(h.calls.map((c) => [c.stepId, c.rev])).toEqual([['s1', 1], ['s2', 2]]);
    expect(h.queue.pending()).toBe(false);
  });

  it('forced steps are saved even when clean, once', async () => {
    const h = harness(1);
    await Promise.all([h.queue.flush('s3'), h.queue.flush('s3')]);
    expect(h.calls.map((c) => c.stepId)).toEqual(['s3']);
  });

  it('adopts the server run on 409 and re-sends local edits with the new rev', async () => {
    const h = harness(1);
    h.bumpServer({ other: { z: 'from MCP' } });
    h.edit('s1', 'a', 'local');
    expect(await h.queue.flush()).toBe(true);
    expect(h.calls.map((c) => c.rev)).toEqual([1, 2]);
    expect(h.draft().answers).toEqual({ other: { z: 'from MCP' }, s1: { a: 'local' } });
  });

  it('reports failure and keeps edits dirty when the network fails, then recovers', async () => {
    let fail = true;
    let draft = setField(emptyDraft('run_1', 'm'), 's1', 'a', 'v');
    let current = run(1);
    const states: SaveState[] = [];
    const queue = createSaveQueue({
      getDraft: () => draft, getRun: () => current, setDraft: (d) => { draft = d; }, setRun: (r) => { current = r; },
      currentStepId: () => undefined, onState: (s) => states.push(s),
      save: async () => {
        if (fail) throw new ApiError('network', 'offline', 0);
        return { run: run(current.rev + 1) };
      },
    });
    expect(await queue.settle()).toBe(false);
    expect(states.at(-1)).toBe('offline');
    expect(draft.dirty).toEqual({ s1: ['a'] });
    fail = false;
    expect(await queue.settle()).toBe(true);
    expect(draft.dirty).toEqual({});
    expect(current.rev).toBe(2);
  });
});
