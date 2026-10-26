// HTTP client of the ingest API (docs/insights-ingest-contract.md). Global fetch (Node >= 18) with an
// AbortController timeout per request. Never sends an Origin header (the server answers 403 origin_forbidden
// to browser-style requests) and never logs the token.
import { ADAPTER, POST_TIMEOUT_MS, SKILL_VERSION } from './constants.mjs';

/**
 * @typedef {{ status: number, reason: string | null, body: any }} HttpResult  status 0 = network error or timeout
 */

const USER_AGENT = `ai-unlocked/${SKILL_VERSION} (${ADAPTER})`;

/**
 * @param {string} url
 * @param {{ method?: string, token?: string, body?: unknown, timeoutMs?: number }} options
 * @returns {Promise<HttpResult>}
 */
async function request(url, { method = 'GET', token, body, timeoutMs = POST_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const reason = parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error.reason === 'string' ? parsed.error.reason : null;
    return { status: res.status, reason, body: parsed };
  } catch {
    return { status: 0, reason: null, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/ingest/v1/turns → 202 {accepted, duplicate} or an error with `reason`. */
export const postTurn = (server, token, payload, timeoutMs = POST_TIMEOUT_MS) =>
  request(`${server}/api/ingest/v1/turns`, { method: 'POST', token, body: payload, timeoutMs });

/** GET /api/ingest/v1/status → feature, consents, token label/expiry, latest skill version. */
export const getStatus = (server, token) => request(`${server}/api/ingest/v1/status`, { token, timeoutMs: 5000 });

/** DELETE /api/ingest/v1/token → revokes the calling token (`uninstall --purge`). */
export const revokeSelf = (server, token) => request(`${server}/api/ingest/v1/token`, { method: 'DELETE', token, timeoutMs: 5000 });

/** POST /api/ingest/v1/pair/start {label, adapter}. */
export const pairStart = (server, label) =>
  request(`${server}/api/ingest/v1/pair/start`, { method: 'POST', body: { label, adapter: ADAPTER }, timeoutMs: 10000 });

/** POST /api/ingest/v1/pair/poll {deviceCode}: 428 pending, 200 {token, expiresAt}, 410 expired/denied, 429 slow_down. */
export const pairPoll = (server, deviceCode) =>
  request(`${server}/api/ingest/v1/pair/poll`, { method: 'POST', body: { deviceCode }, timeoutMs: 10000 });

/** GET /skill/manifest.json (public). */
export const getSkillManifest = (server) => request(`${server}/skill/manifest.json`, { timeoutMs: 5000 });
