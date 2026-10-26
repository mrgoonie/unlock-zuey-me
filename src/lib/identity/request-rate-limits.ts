/**
 * Per-IP and per-learner request throttles applied by src/middleware.ts, backed by the Cloudflare Workers
 * Rate Limiting bindings declared in wrangler.jsonc (`ratelimits`). Per-learner limits alone cannot stop a
 * script that rotates guests (every cookie-less request is a new learner), so guest creation and the
 * expensive or row-writing endpoints are also keyed by the client IP.
 *
 * The bindings are approximate and per Cloudflare location by design; they bound abuse, they are not
 * quotas (the AI budgets in src/lib/coach/ai-usage.ts are the hard money caps). When a binding is absent
 * (unit tests, tooling without ratelimit support) an in-memory fixed window per isolate with the same
 * limits takes over. A binding that throws fails open, logged, so learning never stops on a limiter outage.
 */

export const LIMITER_RULES = {
  /** New guest learners per IP. */
  RL_GUEST_IP: { limit: 20, periodSeconds: 60 },
  /** AI and storage endpoints (chat, hints, submit, evidence upload), per endpoint per IP. */
  RL_AI_IP: { limit: 30, periodSeconds: 60 },
  /** Row-writing endpoints (events, lab results, mission start, run abandon, push subscribe), per endpoint per IP. */
  RL_WRITE_IP: { limit: 120, periodSeconds: 60 },
  /** The same row-writing endpoints, per endpoint per learner. */
  RL_WRITE_LEARNER: { limit: 30, periodSeconds: 60 },
} as const;

export type LimiterName = keyof typeof LIMITER_RULES;

export type ThrottleScope = 'chat' | 'hint' | 'submit' | 'upload' | 'event' | 'lab' | 'start' | 'abandon' | 'push';

export interface ThrottledRoute {
  scope: ThrottleScope;
  ipLimiter: 'RL_AI_IP' | 'RL_WRITE_IP';
  /** Checked after the learner is resolved (the AI endpoints keep their own per-learner KV limits). */
  learnerLimiter?: 'RL_WRITE_LEARNER';
}

const ROUTES: Array<[RegExp, ThrottledRoute]> = [
  [/^\/api\/v1\/coach\/chat$/, { scope: 'chat', ipLimiter: 'RL_AI_IP' }],
  [/^\/api\/v1\/runs\/[^/]+\/hints$/, { scope: 'hint', ipLimiter: 'RL_AI_IP' }],
  [/^\/api\/v1\/runs\/[^/]+\/submit$/, { scope: 'submit', ipLimiter: 'RL_AI_IP' }],
  [/^\/api\/v1\/evidence\/upload$/, { scope: 'upload', ipLimiter: 'RL_AI_IP' }],
  [/^\/api\/v1\/events$/, { scope: 'event', ipLimiter: 'RL_WRITE_IP', learnerLimiter: 'RL_WRITE_LEARNER' }],
  [/^\/api\/v1\/labs\/[^/]+\/result$/, { scope: 'lab', ipLimiter: 'RL_WRITE_IP', learnerLimiter: 'RL_WRITE_LEARNER' }],
  [/^\/api\/v1\/missions\/[^/]+\/start$/, { scope: 'start', ipLimiter: 'RL_WRITE_IP', learnerLimiter: 'RL_WRITE_LEARNER' }],
  [/^\/api\/v1\/runs\/[^/]+\/abandon$/, { scope: 'abandon', ipLimiter: 'RL_WRITE_IP', learnerLimiter: 'RL_WRITE_LEARNER' }],
  [/^\/api\/v1\/push\/subscribe$/, { scope: 'push', ipLimiter: 'RL_WRITE_IP', learnerLimiter: 'RL_WRITE_LEARNER' }],
];

/** The throttle rule for a request, or null when the route is not throttled here. Only POSTs are. */
export function throttledRoute(pathname: string, method: string): ThrottledRoute | null {
  if (method.toUpperCase() !== 'POST') return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return ROUTES.find(([re]) => re.test(path))?.[1] ?? null;
}

/** Expands an IPv6 address to 8 hextets (handles `::` and an embedded IPv4 tail). Null when malformed. */
function ipv6Hextets(ip: string): string[] | null {
  let addr = ip.toLowerCase().split('%')[0];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    addr = `${addr.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...tail];
  return all.every((h) => /^[0-9a-f]{1,4}$/.test(h)) ? all.map((h) => h.replace(/^0+(?=.)/, '')) : null;
}

/**
 * Rate-limit key for the client address from CF-Connecting-IP. IPv6 clients are keyed by their /64
 * (one subscriber usually owns a whole /64, so rotating the interface id must not reset the limit).
 */
export function clientIpKey(request: Request): string {
  const raw = request.headers.get('cf-connecting-ip')?.trim();
  if (!raw) return 'ip:unknown';
  if (!raw.includes(':')) return `ip:${raw}`;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  if (mapped) return `ip:${mapped[1]}`;
  const hextets = ipv6Hextets(raw);
  return hextets ? `ip6:${hextets.slice(0, 4).join(':')}::/64` : `ip:${raw.slice(0, 64)}`;
}

/** In-memory fallback: fixed one-period windows per isolate. */
const fallbackWindows = new Map<string, { window: number; count: number }>();
const FALLBACK_MAX_KEYS = 10_000;

function fallbackAllow(name: LimiterName, key: string, now: number): boolean {
  const { limit, periodSeconds } = LIMITER_RULES[name];
  const window = Math.floor(now / (periodSeconds * 1000));
  const id = `${name}|${key}`;
  const entry = fallbackWindows.get(id);
  if (!entry || entry.window !== window) {
    // Bounded memory: old windows are worthless, so dropping everything is safe.
    if (fallbackWindows.size >= FALLBACK_MAX_KEYS) fallbackWindows.clear();
    fallbackWindows.set(id, { window, count: 1 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

/** Test hook: forgets every in-memory fallback window. */
export function resetFallbackLimiter(): void {
  fallbackWindows.clear();
}

export type RateLimitBindings = Partial<Record<LimiterName, RateLimit>>;

/** True when the request identified by `key` may proceed under limiter `name`. */
export async function allowByLimiter(env: RateLimitBindings, name: LimiterName, key: string, now = Date.now()): Promise<boolean> {
  const binding = env[name];
  if (!binding) return fallbackAllow(name, key, now);
  try {
    return (await binding.limit({ key })).success;
  } catch (err) {
    console.error('rate limit binding failed', name, err instanceof Error ? err.message : err);
    return true;
  }
}

export const RATE_LIMITED_MESSAGE = 'Bạn thao tác hơi nhanh. Đợi một phút rồi thử lại nhé.';
export const GUEST_LIMITED_MESSAGE = 'Mạng của bạn vừa mở quá nhiều phiên học mới. Đợi một phút rồi tải lại trang nhé.';
