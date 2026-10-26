/**
 * Soft per-learner rate limit in KV (fixed one-minute windows). KV is eventually consistent, so this is a
 * guard against runaway clients, not an exact quota. KV failures fail open (logged) so learning never stops.
 */
export const RATE_LIMITS = {
  chat: 20,
  hint: 20,
  upload: 20,
} as const;

export async function allowRequest(
  kv: KVNamespace, scope: keyof typeof RATE_LIMITS, learnerId: string, now: Date,
): Promise<boolean> {
  const key = `rl:${scope}:${learnerId}:${Math.floor(now.getTime() / 60_000)}`;
  try {
    const used = Number.parseInt((await kv.get(key)) ?? '0', 10) || 0;
    if (used >= RATE_LIMITS[scope]) return false;
    // 120 s TTL (KV minimum is 60 s) outlives the window.
    await kv.put(key, String(used + 1), { expirationTtl: 120 });
    return true;
  } catch (err) {
    console.error('rate limit kv error', scope, err);
    return true;
  }
}
