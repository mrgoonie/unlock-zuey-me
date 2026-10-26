import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLocalLabsDone, recordLabResult, sanitizeResult, trackLabStarted } from '../../src/lib/labs/lab-recorder';
import { getLab, LABS, requireLab } from '../../src/lib/labs/registry';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('lab registry', () => {
  it('matches the lab ids allowed by the content schema', () => {
    const schema = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'content', 'schema.ts'), 'utf8');
    for (const lab of LABS) expect(schema).toContain(`'${lab.id}'`);
    expect(new Set(LABS.map((l) => l.id)).size).toBe(LABS.length);
  });

  it('looks labs up by id', () => {
    expect(getLab('context-lab')?.conceptId).toBe('context');
    expect(getLab('nope')).toBeUndefined();
    expect(requireLab('token-predictor').minutes).toBeGreaterThanOrEqual(3);
  });
});

describe('lab recorder', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sanitizes results', () => {
    expect(sanitizeResult({ score: 7.6, total: 5, calibration: 140 })).toEqual({ score: 5, total: 5, calibration: 100 });
    expect(sanitizeResult({ score: -1, total: Number.NaN })).toEqual({ score: 0, total: 0 });
  });

  it('posts the result and returns labsDone', async () => {
    const fetchImpl = vi.fn(async () => json(200, { labsDone: ['context-lab'], newBadges: [] }));
    const out = await recordLabResult('context-lab', { score: 2, total: 3 }, fetchImpl);
    expect(out).toEqual({ ok: true, labsDone: ['context-lab'] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/labs/context-lab/result');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ result: { score: 2, total: 3 } });
  });

  it('never throws on 404, server errors, bad JSON or network failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await recordLabResult('x', { score: 1, total: 1 }, async () => json(404, {}))).toEqual({ ok: false, reason: 'not_found' });
    expect(await recordLabResult('x', { score: 1, total: 1 }, async () => json(500, {}))).toEqual({ ok: false, reason: 'error' });
    expect(await recordLabResult('x', { score: 1, total: 1 }, async () => new Response('nope'))).toEqual({ ok: false, reason: 'error' });
    expect(await recordLabResult('x', { score: 1, total: 1 }, async () => Promise.reject(new Error('offline')))).toEqual({
      ok: false,
      reason: 'error',
    });
    warn.mockRestore();
  });

  it('fires lab.started without throwing even when fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => Promise.reject(new Error('offline')));
    expect(() => trackLabStarted('token-predictor', fetchImpl)).not.toThrow();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: 'lab.started', props: { labId: 'token-predictor' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('remembers finished labs locally and tolerates corrupt storage', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    await recordLabResult('context-lab', { score: 1, total: 3 }, async () => json(404, {}));
    expect(readLocalLabsDone()).toEqual(['context-lab']);
    store.set('labs.done', '{not json');
    expect(readLocalLabsDone()).toEqual([]);
  });
});
