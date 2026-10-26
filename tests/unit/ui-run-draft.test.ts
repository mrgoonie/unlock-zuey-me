import { describe, expect, it } from 'vitest';
import type { MissionRun } from '../../src/lib/learning/types';
import {
  clearAttempt, emptyDraft, ensureAttemptKey, evidenceFingerprint, hasDirty, loadDraft, markSaved, mergeServerRun,
  removeDraft, restoreDraft, saveDraft, setField,
} from '../../src/lib/ui/run-draft';

const run = (over: Partial<MissionRun> = {}): MissionRun => ({
  id: 'run_1', learnerId: 'lrn_1', missionId: 'plan-weekend', missionVersion: 1, status: 'started', currentStep: null,
  answers: {}, confidence: null, hintMaxLevel: 0, hintsUsed: 0, revealed: [], source: 'web', rev: 1,
  startedAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z', completedAt: null, ...over,
});

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

describe('run draft: dirty tracking', () => {
  it('marks edited fields dirty without mutating the input', () => {
    const d0 = emptyDraft('run_1', 'plan-weekend');
    const d1 = setField(d0, 'constraints', 'goal', 'Nghỉ ngơi');
    expect(d0.answers).toEqual({});
    expect(d1.answers.constraints.goal).toBe('Nghỉ ngơi');
    expect(d1.dirty).toEqual({ constraints: ['goal'] });
    expect(hasDirty(d1)).toBe(true);
  });

  it('clears only fields whose value is still what was sent', () => {
    let d = setField(emptyDraft('run_1', 'm'), 's1', 'a', 'one');
    d = setField(d, 's1', 'b', 'two');
    const sent = { ...d.answers.s1 };
    d = setField(d, 's1', 'b', 'two, edited while saving');
    const after = markSaved(d, 's1', sent);
    expect(after.dirty).toEqual({ s1: ['b'] });
    expect(hasDirty(markSaved(after, 's1', after.answers.s1))).toBe(false);
  });
});

describe('run draft: 409 merge', () => {
  it('adopts server answers and keeps unsaved local edits on top', () => {
    let d = setField(emptyDraft('run_1', 'm'), 'constraints', 'goal', 'local goal');
    d = setField(d, 'constraints', 'constraints', ['a', 'b', 'c']);
    const server = run({ rev: 5, answers: { constraints: { goal: 'server goal', location: 'Quận 7' }, reflect: { lesson: 'từ MCP' } } });
    const merged = mergeServerRun(d, server);
    expect(merged.answers).toEqual({
      constraints: { goal: 'local goal', location: 'Quận 7', constraints: ['a', 'b', 'c'] },
      reflect: { lesson: 'từ MCP' },
    });
    expect(merged.dirty).toEqual(d.dirty);
  });

  it('does not copy the server object by reference', () => {
    const server = run({ answers: { s: { f: 'x' } } });
    const merged = mergeServerRun(emptyDraft('run_1', 'm'), server);
    merged.answers.s.f = 'changed';
    expect(server.answers.s.f).toBe('x');
  });

  it('restores a reload: server answers + local unsaved edits + server confidence fallback', () => {
    const local = setField(emptyDraft('run_1', 'm'), 'reflect', 'lesson', 'chưa kịp lưu');
    const restored = restoreDraft(run({ answers: { verify: { 'claim-hours': 'needs_lookup' } }, confidence: 70 }), local);
    expect(restored.answers).toEqual({ verify: { 'claim-hours': 'needs_lookup' }, reflect: { lesson: 'chưa kịp lưu' } });
    expect(restored.confidence).toBe(70);
    expect(restoreDraft(run(), null).runId).toBe('run_1');
  });

  it('prefers the server value for fields locked by a reveal made on another device', () => {
    let local = emptyDraft('run_1', 'plan-weekend');
    local = setField(local, 'quiz', 'q1', 'b'); // revealed elsewhere: locked at 'a'
    local = setField(local, 'quiz', 'q2', 'mine'); // not revealed: the local edit wins
    local = setField(local, 'predict', 'choice', 'opt-x'); // prediction reveal locks choice + confidence
    local = setField(local, 'predict', 'confidence', 90);
    local = setField(local, 'predict', 'note', 'giữ lại');
    const server = run({
      answers: { quiz: { q1: 'a', q2: 'x' }, predict: { choice: 'opt-y', confidence: 40 } },
      revealed: ['quiz:q1', 'predict:prediction'],
    });
    const restored = restoreDraft(server, local);
    expect(restored.answers).toEqual({ quiz: { q1: 'a', q2: 'mine' }, predict: { choice: 'opt-y', confidence: 40, note: 'giữ lại' } });
    expect(restored.dirty).toEqual({ quiz: ['q2'], predict: ['note'] });
  });
});

describe('run draft: idempotency key per attempt', () => {
  let n = 0;
  const gen = () => `key-${++n}`;

  it('reuses the key while the evidence is unchanged (safe retry)', () => {
    const d = setField(emptyDraft('run_1', 'm'), 's', 'f', 'v');
    const a = ensureAttemptKey(d, gen);
    const b = ensureAttemptKey(a, gen);
    expect(b.attempt?.key).toBe(a.attempt?.key);
  });

  it('issues a new key when evidence changes or after a definitive grade', () => {
    const a = ensureAttemptKey(setField(emptyDraft('run_1', 'm'), 's', 'f', 'v'), gen);
    const edited = ensureAttemptKey(setField(a, 's', 'f', 'v2'), gen);
    expect(edited.attempt?.key).not.toBe(a.attempt?.key);
    const conf = ensureAttemptKey({ ...edited, confidence: 80 }, gen);
    expect(conf.attempt?.key).not.toBe(edited.attempt?.key);
    const fresh = ensureAttemptKey(clearAttempt(conf), gen);
    expect(fresh.attempt?.key).not.toBe(conf.attempt?.key);
  });

  it('fingerprint ignores key order and image order', () => {
    const x = { answers: { a: { x: '1', y: '2' } }, confidence: 50, imageKeys: ['i2', 'i1'] };
    const y = { answers: { a: { y: '2', x: '1' } }, confidence: 50, imageKeys: ['i1', 'i2'] };
    expect(evidenceFingerprint(x)).toBe(evidenceFingerprint(y));
  });
});

describe('run draft: localStorage mirror', () => {
  it('round-trips, ignores corrupt or foreign entries, and removes', () => {
    const s = new MemoryStorage();
    const d = setField(emptyDraft('run_1', 'm'), 's', 'f', 'v');
    saveDraft(d, s);
    expect(loadDraft('run_1', s)?.answers).toEqual(d.answers);
    s.setItem('aiu:draft:run_2', '{not json');
    expect(loadDraft('run_2', s)).toBeNull();
    s.setItem('aiu:draft:run_3', JSON.stringify({ ...d, runId: 'run_x' }));
    expect(loadDraft('run_3', s)).toBeNull();
    removeDraft('run_1', s);
    expect(loadDraft('run_1', s)).toBeNull();
  });

  it('fills fields missing from older drafts with defaults', () => {
    const s = new MemoryStorage();
    s.setItem('aiu:draft:run_1', JSON.stringify({ runId: 'run_1', missionId: 'm', answers: {} }));
    const d = loadDraft('run_1', s);
    expect(d?.hints).toEqual({});
    expect(d?.imageKeys).toEqual([]);
  });

  it('never throws when storage is unavailable', () => {
    const broken = { setItem: () => { throw new Error('quota'); }, getItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('x'); } } as unknown as Storage;
    expect(() => saveDraft(emptyDraft('r', 'm'), broken)).not.toThrow();
    expect(loadDraft('r', broken)).toBeNull();
    expect(() => removeDraft('r', broken)).not.toThrow();
  });
});
