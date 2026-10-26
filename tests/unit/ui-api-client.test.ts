import { describe, expect, it, vi } from 'vitest';
import { ApiError, DEFAULT_TIMEOUT_MS, friendlyMessage, request, toApiError } from '../../src/lib/ui/api-client';

/** Resolves with the ApiError a request rejected with (fails the test if it resolved). */
const fail = (p: Promise<unknown>): Promise<ApiError> =>
  p.then(() => { throw new Error('expected the request to fail'); }, (e: ApiError) => e);

const jsonResponse = (status: number, body: unknown) =>
  new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client error mapping', () => {
  it('uses the contract error code and message', () => {
    const e = toApiError(429, { error: { code: 'budget_exceeded', message: 'Hết hạn mức hôm nay' } });
    expect(e.code).toBe('budget_exceeded');
    expect(e.message).toBe('Hết hạn mức hôm nay');
    expect(e.status).toBe(429);
  });

  it('falls back to the HTTP status and Vietnamese copy for unknown bodies', () => {
    expect(toApiError(404, null).code).toBe('not_found');
    expect(toApiError(409, 'oops').code).toBe('conflict');
    expect(toApiError(503, { error: { code: 'weird' } }).code).toBe('unavailable');
    expect(toApiError(502, null).code).toBe('internal');
    expect(toApiError(500, null).message).toMatch(/vẫn được giữ/);
  });

  it('keeps the body so a 409 exposes the server run', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(409, { error: { code: 'conflict', message: 'stale' }, run: { rev: 7 } }));
    const err = await fail(request('PATCH', '/api/v1/runs/r/answers', { rev: 1 }, { fetcher }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('conflict');
    expect((err.body as { run: { rev: number } }).run.rev).toBe(7);
  });

  it('maps network failures to code "network"', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await fail(request('GET', '/api/v1/missions', undefined, { fetcher }));
    expect(err.code).toBe('network');
    expect(friendlyMessage(err)).toMatch(/mất kết nối/);
  });

  it('aborts slow calls after timeoutMs as a network error', async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const err = await fail(request('POST', '/x', {}, { fetcher, timeoutMs: 10 }));
    expect(err.code).toBe('network');
  });

  it('applies a default deadline to calls without timeoutMs (start/getRun never hang)', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const pending = fail(request('GET', '/api/v1/runs/r', undefined, { fetcher }));
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
      const err = await pending;
      expect(err.code).toBe('network');
      expect(err.message).toMatch(/thử lại/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends JSON with same-origin credentials and parses the reply', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const res = await request<{ ok: boolean }>('POST', '/api/v1/events', { name: 'x' }, { fetcher });
    expect(res.ok).toBe(true);
    const [, init] = fetcher.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ name: 'x' });
  });

  it('passes FormData through untouched and tolerates empty bodies', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    const res = await request('POST', '/api/v1/evidence/upload', form, { fetcher });
    expect(res).toBeNull();
    expect(fetcher.mock.calls[0][1].body).toBe(form);
    expect(fetcher.mock.calls[0][1].headers['content-type']).toBeUndefined();
  });

  it('friendlyMessage hides non-API errors behind reassuring copy', () => {
    expect(friendlyMessage(new Error('stack trace'))).toMatch(/vẫn được giữ/);
  });
});
