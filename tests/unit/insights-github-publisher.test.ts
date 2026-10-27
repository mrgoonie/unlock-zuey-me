/**
 * GitHub publisher against a fetch mock (no real network): headers, marker search, labels, error handling,
 * and the token never appearing in errors or logs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_HANDLE_LABEL, createGithubIssuePublisher, GithubIssueError, githubTokenConfigured, issueLabels,
} from '../../src/lib/insights/github-issue-publisher';
import { FAKE_TOKEN, fakeGithub } from './insights-proposal-stage-fixtures';

const FP = 'b'.repeat(64);
const env = (over: Partial<Env> = {}) => ({ GITHUB_ISSUES_TOKEN: FAKE_TOKEN, ...over }) as Env;

afterEach(() => vi.restoreAllMocks());

describe('github issue publisher', () => {
  it('does not exist without a token', () => {
    expect(createGithubIssuePublisher({} as Env)).toBeNull();
    expect(createGithubIssuePublisher(env({ GITHUB_ISSUES_TOKEN: '  ' }))).toBeNull();
    expect(githubTokenConfigured({} as Env)).toBe(false);
    expect(githubTokenConfigured(env())).toBe(true);
  });

  it('sends the token only in the Authorization header, with API version, user agent and the configured repo', async () => {
    const gh = fakeGithub();
    const pub = createGithubIssuePublisher(env({ INSIGHTS_GITHUB_REPO: 'acme/widgets' }), gh.fetchImpl);
    await pub?.createIssue({ title: 'T', body: 'B', category: 'bug', aiHandle: false });
    const call = gh.calls[0];
    expect(call.url).toBe('https://api.github.com/repos/acme/widgets/issues');
    expect(call.headers).toMatchObject({
      authorization: `Bearer ${FAKE_TOKEN}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'unlock-zuey-me-insights',
    });
    expect(call.url).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(call.body)).not.toContain(FAKE_TOKEN);
  });

  it('falls back to the default repo for a malformed INSIGHTS_GITHUB_REPO', () => {
    expect(createGithubIssuePublisher(env({ INSIGHTS_GITHUB_REPO: 'not a repo' }))?.repo).toBe('mrgoonie/unlock-zuey-me');
  });

  it('labels: ai-insights + insight:<category>, ai-handle only on request, nothing implying merge', async () => {
    expect(issueLabels('content', false)).toEqual(['ai-insights', 'insight:content']);
    expect(issueLabels('bug', true)).toEqual(['ai-insights', 'insight:bug', AI_HANDLE_LABEL]);
    for (const c of ['bug', 'content', 'ux', 'feature'] as const) {
      for (const l of [...issueLabels(c, true), ...issueLabels(c, false)]) expect(l).not.toMatch(/merge|auto|approve/i);
    }
    const gh = fakeGithub();
    const pub = createGithubIssuePublisher(env(), gh.fetchImpl);
    await pub?.createIssue({ title: 'T', body: 'B', category: 'ux', aiHandle: false });
    expect(gh.issues[0].labels).toEqual(['ai-insights', 'insight:ux']);
  });

  it('search returns only real issues whose body carries the exact marker', async () => {
    const items = [
      { number: 1, html_url: 'https://github.com/x/y/issues/1', state: 'open', body: `x <!-- ai-unlocked-fp:${FP} -->` },
      { number: 2, html_url: 'https://github.com/x/y/issues/2', state: 'closed', closed_at: '2026-10-01T00:00:00Z', state_reason: 'completed', body: `ai-unlocked-fp:${FP}` },
      { number: 3, html_url: 'https://github.com/x/y/pull/3', state: 'open', body: `ai-unlocked-fp:${FP}`, pull_request: {} },
      { number: 4, html_url: 'https://github.com/x/y/issues/4', state: 'open', body: `ai-unlocked-fp:${'c'.repeat(64)}` },
    ];
    const urls: string[] = [];
    const pub = createGithubIssuePublisher(env(), async (url) => {
      urls.push(url);
      return Response.json({ items });
    });
    const found = await pub?.searchByFingerprint(FP);
    expect(found?.map((i) => [i.number, i.state, i.closedAt])).toEqual([[1, 'open', null], [2, 'closed', '2026-10-01T00:00:00Z']]);
    expect(decodeURIComponent(urls[0])).toContain(`repo:mrgoonie/unlock-zuey-me is:issue in:body "ai-unlocked-fp:${FP}"`);
    await expect(pub?.searchByFingerprint('not-a-fingerprint')).rejects.toBeInstanceOf(GithubIssueError);
  });

  it.each([422, 401, 403, 500, 503])('a %s answer throws status + endpoint only, and logs no token or body', async (status) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pub = createGithubIssuePublisher(env(), async () =>
      new Response(JSON.stringify({ message: `Bad credentials ${FAKE_TOKEN}` }), { status }));
    const err = await pub?.createIssue({ title: 'T', body: 'B', category: 'bug', aiHandle: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubIssueError);
    expect((err as GithubIssueError).status).toBe(status);
    expect((err as Error).message).toBe(`github ${status} POST /repos/:repo/issues`);
    expect(JSON.stringify(err)).not.toContain(FAKE_TOKEN);
    expect(String((err as Error).stack)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('Bad credentials');
  });

  it('maps network failures and timeouts to status 0 without leaking the token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pub = createGithubIssuePublisher(env(), async () => {
      throw new TypeError(`fetch failed for ${FAKE_TOKEN}`);
    });
    const err = await pub?.getIssueState(7).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, endpoint: 'GET /repos/:repo/issues/:n' });
    expect((err as Error).message).not.toContain(FAKE_TOKEN);
  });

  it('aborts a hung request after 10 s', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const pub = createGithubIssuePublisher(env(), (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const pending = pub?.getIssueState(1).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({ status: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads issue state and adds labels', async () => {
    const gh = fakeGithub();
    const pub = createGithubIssuePublisher(env(), gh.fetchImpl);
    const created = await pub?.createIssue({ title: 'T', body: 'B', category: 'bug', aiHandle: false });
    await pub?.addLabels(created?.number ?? 0, [AI_HANDLE_LABEL]);
    expect(gh.issues[0].labels).toContain(AI_HANDLE_LABEL);
    expect(await pub?.getIssueState(created?.number ?? 0)).toMatchObject({ number: 100, state: 'open', closedAt: null });
  });
});

describe('github issue publisher: issue list lookup by fingerprint', () => {
  const issue = (n: number, body: string, extra: Record<string, unknown> = {}) =>
    ({ number: n, html_url: `https://github.com/mrgoonie/unlock-zuey-me/issues/${n}`, state: 'open', body, ...extra });

  it('lists ai-insights issues since a time and keeps only real issues carrying the exact marker', async () => {
    const urls: string[] = [];
    const pub = createGithubIssuePublisher(env(), async (url) => {
      urls.push(url);
      return Response.json([
        issue(1, `x <!-- ai-unlocked-fp:${FP} --> y`), issue(2, 'other'), issue(3, `ai-unlocked-fp:${FP}`, { pull_request: {} }),
      ]);
    });
    const found = await pub?.listByFingerprintSince(FP, '2026-10-26T09:00:00.000Z');
    expect(found?.map((i) => i.number)).toEqual([1]);
    expect(new URL(urls[0]).pathname).toBe('/repos/mrgoonie/unlock-zuey-me/issues');
    expect(Object.fromEntries(new URL(urls[0]).searchParams)).toMatchObject({
      state: 'all', labels: 'ai-insights', since: '2026-10-26T09:00:00.000Z', page: '1', per_page: '100',
    });
  });

  it('pages through full pages and errors rather than answering "none" when the listing is incomplete', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const full = Array.from({ length: 100 }, (_, i) => issue(i + 10, 'unrelated'));
    let pages = 0;
    const pub = createGithubIssuePublisher(env(), async (url) => {
      pages++;
      return Response.json(new URL(url).searchParams.get('page') === '2' ? [issue(5, `ai-unlocked-fp:${FP}`)] : full);
    });
    expect((await pub?.listByFingerprintSince(FP, '2026-10-26T09:00:00.000Z'))?.map((i) => i.number)).toEqual([5]);
    expect(pages).toBe(2);
    const endless = createGithubIssuePublisher(env(), async () => Response.json(full));
    expect(await endless?.listByFingerprintSince(FP, '2026-10-26T09:00:00.000Z').catch((e: unknown) => e))
      .toMatchObject({ status: 502, endpoint: 'GET /repos/:repo/issues' });
  });

  it('rejects a malformed fingerprint or time before any network call', async () => {
    const fetchImpl = vi.fn();
    const pub = createGithubIssuePublisher(env(), fetchImpl);
    expect(await pub?.listByFingerprintSince('nope', '2026-10-26T09:00:00.000Z').catch((e: unknown) => e)).toBeInstanceOf(GithubIssueError);
    expect(await pub?.listByFingerprintSince(FP, 'yesterday').catch((e: unknown) => e)).toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
