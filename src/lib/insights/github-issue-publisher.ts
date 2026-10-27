/**
 * GitHub Issues client of the insights pipeline. THE ONLY MODULE THAT READS `env.GITHUB_ISSUES_TOKEN`.
 *
 * Server-side only (cron stage and admin API). The token goes into the Authorization header and nowhere
 * else: errors carry only the HTTP status and an endpoint template (`GithubIssueError`), logs never include
 * the token, a response body or the request body, and no response of ours ever serialises it.
 *
 * Labels are fixed: `ai-insights`, `insight:<category>`, and `ai-handle` only when the caller passes
 * `aiHandle: true` from a gate decision or a recorded operator approval. No label implies merging.
 */
import { githubIssuesRepo } from './feature-flags';
import type { SignalCategory } from './insight-types';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'unlock-zuey-me-insights';
export const GITHUB_TIMEOUT_MS = 10_000;
export const AI_HANDLE_LABEL = 'ai-handle';

/** Minimal fetch signature (injected in tests; no real network there). */
export type GithubFetch = (input: string, init: RequestInit) => Promise<Response>;

export type GithubEndpoint =
  | 'GET /search/issues' | 'GET /repos/:repo/issues' | 'POST /repos/:repo/issues' | 'POST /repos/:repo/issues/:n/labels' | 'GET /repos/:repo/issues/:n';

/** Label every issue of the pipeline carries; the issue list is filtered by it. */
export const INSIGHTS_LABEL = 'ai-insights';
/** Pages of 100 read by `listByFingerprintSince` before it gives up (and reports an error instead of "absent"). */
export const LIST_MAX_PAGES = 5;
const fingerprintMarker = (fingerprint: string, endpoint: GithubEndpoint): string => {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new GithubIssueError(400, endpoint);
  return `ai-unlocked-fp:${fingerprint}`;
};

/** A failed GitHub call. Carries status and endpoint template only, never the token or a body. */
export class GithubIssueError extends Error {
  constructor(public status: number, public endpoint: GithubEndpoint) {
    super(`github ${status || 'network'} ${endpoint}`);
    this.name = 'GithubIssueError';
  }
}

export interface GithubIssueRef {
  number: number;
  url: string;
  state: 'open' | 'closed';
  closedAt: string | null;
  /** completed | not_planned | reopened | null */
  stateReason: string | null;
}

export interface GithubIssuePublisher {
  readonly repo: string;
  /** Issues (open and closed) whose body carries the exact fingerprint marker. The search index lags behind creates. */
  searchByFingerprint(fingerprint: string): Promise<GithubIssueRef[]>;
  /**
   * Pipeline issues (label `ai-insights`) updated since `since` whose body carries the marker, read from the
   * repository issue list, which is not search-indexed and so sees an issue as soon as it exists. Throws
   * instead of answering "none" when the listing is incomplete.
   */
  listByFingerprintSince(fingerprint: string, since: string): Promise<GithubIssueRef[]>;
  createIssue(input: { title: string; body: string; category: SignalCategory; aiHandle: boolean }): Promise<GithubIssueRef>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  getIssueState(issueNumber: number): Promise<GithubIssueRef>;
}

/** Whether the token secret is set (a boolean, safe to show in the admin UI). */
export const githubTokenConfigured = (env: Pick<Env, 'GITHUB_ISSUES_TOKEN'>): boolean => !!env.GITHUB_ISSUES_TOKEN?.trim();

/** The labels an issue gets. `ai-handle` only on explicit request. */
export function issueLabels(category: SignalCategory, aiHandle: boolean): string[] {
  return [INSIGHTS_LABEL, `insight:${category}`, ...(aiHandle ? [AI_HANDLE_LABEL] : [])];
}

interface RawIssue {
  number?: unknown;
  html_url?: unknown;
  state?: unknown;
  closed_at?: unknown;
  state_reason?: unknown;
  body?: unknown;
  pull_request?: unknown;
}

function toRef(raw: RawIssue, endpoint: GithubEndpoint): GithubIssueRef {
  if (typeof raw.number !== 'number' || typeof raw.html_url !== 'string') throw new GithubIssueError(502, endpoint);
  return {
    number: raw.number,
    url: raw.html_url,
    state: raw.state === 'closed' ? 'closed' : 'open',
    closedAt: typeof raw.closed_at === 'string' ? raw.closed_at : null,
    stateReason: typeof raw.state_reason === 'string' ? raw.state_reason : null,
  };
}

/** Null when no token is configured: callers then never reach the network. */
export function createGithubIssuePublisher(
  env: Pick<Env, 'GITHUB_ISSUES_TOKEN' | 'INSIGHTS_GITHUB_REPO'>,
  fetchImpl: GithubFetch = (input, init) => fetch(input, init),
): GithubIssuePublisher | null {
  const token = env.GITHUB_ISSUES_TOKEN?.trim();
  if (!token) return null;
  const repo = githubIssuesRepo(env);

  async function call<T>(endpoint: GithubEndpoint, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          'user-agent': USER_AGENT,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      console.error('github call failed', 'network', endpoint);
      throw new GithubIssueError(0, endpoint);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      console.error('github call failed', res.status, endpoint);
      await res.body?.cancel().catch(() => undefined);
      throw new GithubIssueError(res.status, endpoint);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new GithubIssueError(502, endpoint);
    }
  }

  return {
    repo,
    async searchByFingerprint(fingerprint) {
      const marker = fingerprintMarker(fingerprint, 'GET /search/issues');
      const q = encodeURIComponent(`repo:${repo} is:issue in:body "${marker}"`);
      const data = await call<{ items?: RawIssue[] }>('GET /search/issues', 'GET', `/search/issues?q=${q}&per_page=10`);
      // Search is fuzzy: keep only real issues whose body carries the exact marker.
      return (Array.isArray(data.items) ? data.items : [])
        .filter((i) => !i.pull_request && typeof i.body === 'string' && i.body.includes(marker))
        .map((i) => toRef(i, 'GET /search/issues'));
    },
    async listByFingerprintSince(fingerprint, since) {
      const endpoint = 'GET /repos/:repo/issues';
      const marker = fingerprintMarker(fingerprint, endpoint);
      if (!Number.isFinite(Date.parse(since))) throw new GithubIssueError(400, endpoint);
      const found: GithubIssueRef[] = [];
      for (let page = 1; page <= LIST_MAX_PAGES; page++) {
        const q = new URLSearchParams({
          state: 'all', labels: INSIGHTS_LABEL, since: new Date(since).toISOString(), sort: 'created', direction: 'desc',
          per_page: '100', page: String(page),
        });
        const items = await call<RawIssue[]>(endpoint, 'GET', `/repos/${repo}/issues?${q}`);
        if (!Array.isArray(items)) throw new GithubIssueError(502, endpoint);
        for (const i of items) {
          if (!i.pull_request && typeof i.body === 'string' && i.body.includes(marker)) found.push(toRef(i, endpoint));
        }
        if (items.length < 100) return found;
      }
      // More pipeline issues changed since then than we read: "not found" would not be a proof.
      throw new GithubIssueError(502, endpoint);
    },
    async createIssue({ title, body, category, aiHandle }) {
      const raw = await call<RawIssue>('POST /repos/:repo/issues', 'POST', `/repos/${repo}/issues`, {
        title, body, labels: issueLabels(category, aiHandle),
      });
      return toRef(raw, 'POST /repos/:repo/issues');
    },
    async addLabels(issueNumber, labels) {
      await call<unknown>('POST /repos/:repo/issues/:n/labels', 'POST', `/repos/${repo}/issues/${Math.trunc(issueNumber)}/labels`, { labels });
    },
    async getIssueState(issueNumber) {
      const raw = await call<RawIssue>('GET /repos/:repo/issues/:n', 'GET', `/repos/${repo}/issues/${Math.trunc(issueNumber)}`);
      return toRef(raw, 'GET /repos/:repo/issues/:n');
    },
  };
}
