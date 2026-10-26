/**
 * Cron cleanup for auth data: expired /mcp OAuth grants and tokens in OAUTH_KV (one bounded batch per run,
 * resuming from a cursor kept in CACHE), plus expired login requests and browser sessions in D1.
 */
import { purgeExpiredLoginRequests } from '../identity/login-requests';
import { purgeExpiredSessions } from '../identity/session-store';
import { getOAuthHelpers } from './oauth-options';

const CURSOR_KEY = 'oauth-purge:cursor';
/** Grants (and then tokens) checked per run unless the caller passes a smaller batch. */
export const OAUTH_PURGE_BATCH_SIZE = 500;

export async function purgeExpiredAuthData(env: Env, now = new Date(), batchSize = OAUTH_PURGE_BATCH_SIZE): Promise<void> {
  const cursor = (await env.CACHE.get(CURSOR_KEY)) ?? undefined;
  const result = await getOAuthHelpers(env).purgeExpiredData({ batchSize: Math.max(1, Math.floor(batchSize)), cursor });
  if (result.done || !result.cursor) await env.CACHE.delete(CURSOR_KEY);
  else await env.CACHE.put(CURSOR_KEY, result.cursor, { expirationTtl: 24 * 60 * 60 });
  await purgeExpiredLoginRequests(env.DB, now);
  await purgeExpiredSessions(env.DB, now);
}
