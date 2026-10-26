/**
 * Request gates of the insights feature. `requireInsightsLearner` guards the web-session routes under
 * /api/v1/insights; the rest guards every /api/ingest/v1 endpoint.
 *
 * Ingest gate: These are for non-browser clients only (the ai-unlocked
 * CLI and Stop hook): they read no cookie, `learnerPolicy` gives them no session, and they sit outside the
 * /api/v1 same-origin rule, so they reject any request that carries an `Origin` header themselves.
 *
 * Order: INSIGHTS_MODE off → 404 before anything else (the routes look absent) → Origin → per-IP limit
 * (before any D1 lookup) → bearer token → feature enabled for the token's learner → per-learner limit.
 */
import { apiError } from '../http/api-response';
import { allowByLimiter, clientIpKey } from '../identity/request-rate-limits';
import { requireLearner, type LearnerRouteContext, type RouteLocals } from '../privacy/learner-route-context';
import { insightsEnabledFor, insightsMode } from './feature-flags';
import { ingestError } from './ingest-contract';
import { resolveToken, touchToken, type ResolvedIngestToken } from './ingest-tokens';

export type IngestAuth = ResolvedIngestToken;

export type GateResult<T> = { ok: true; value: T } | { ok: false; response: Response };

export const FEATURE_OFF_MESSAGE = 'Không tìm thấy.';
export const ORIGIN_FORBIDDEN_MESSAGE = 'Điểm nhận dữ liệu này chỉ dành cho công cụ ai-unlocked, không dùng từ trình duyệt.';
export const INGEST_RATE_LIMITED_MESSAGE = 'Gửi quá nhanh. Thử lại sau ít phút.';
const UNAUTHORIZED_MESSAGE = 'Mã thiết bị không hợp lệ, đã hết hạn hoặc đã bị thu hồi. Hãy ghép nối lại thiết bị.';

/**
 * Checks shared by the bearer-less pairing endpoints and the token endpoints: the feature exists at all,
 * no browser Origin, and the per-IP limit under `scope` (`ingest`, `pair`).
 */
export async function guardIngestRequest(request: Request, env: Env, scope: string): Promise<Response | null> {
  if (insightsMode(env) === 'off') return ingestError('feature_off', FEATURE_OFF_MESSAGE);
  if (request.headers.has('origin')) return ingestError('origin_forbidden', ORIGIN_FORBIDDEN_MESSAGE);
  if (!(await allowByLimiter(env, 'RL_WRITE_IP', `${scope}:${clientIpKey(request)}`))) {
    return ingestError('rate_limited', INGEST_RATE_LIMITED_MESSAGE);
  }
  return null;
}

export const SIGN_IN_REQUIRED_MESSAGE = 'Hãy đăng nhập tài khoản zuey.me để dùng ai-tutor và ghép nối thiết bị.';

/**
 * Gate for the web-session routes under /api/v1/insights: INSIGHTS_MODE off → 404; no session → 401;
 * a guest → 404, or 403 with a sign-in message when `guestSignIn` is set (pairing confirm); the feature not
 * enabled for this member → 404.
 */
export function requireInsightsLearner(locals: RouteLocals, opts: { guestSignIn?: boolean } = {}): LearnerRouteContext | Response {
  const env = locals.runtime.env;
  if (insightsMode(env) === 'off') return apiError('not_found', FEATURE_OFF_MESSAGE);
  const ctx = requireLearner(locals);
  if (ctx instanceof Response) return ctx;
  if (ctx.learner.kind !== 'member' && opts.guestSignIn) return apiError('forbidden', SIGN_IN_REQUIRED_MESSAGE);
  if (!insightsEnabledFor(env, ctx.learner)) return apiError('not_found', FEATURE_OFF_MESSAGE);
  return ctx;
}

/** `Authorization: Bearer <token>` → the raw token, or null. */
export function bearerToken(request: Request): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.get('authorization') ?? '');
  return m ? m[1] : null;
}

/** Authenticates an ingest request. The learner always comes from the token row, never from the body. */
export async function authenticateIngest(request: Request, env: Env, now: Date = new Date()): Promise<GateResult<IngestAuth>> {
  const blocked = await guardIngestRequest(request, env, 'ingest');
  if (blocked) return { ok: false, response: blocked };
  const auth = await resolveToken(env.DB, bearerToken(request), now, env.ADMIN_EMAILS);
  if (!auth) return { ok: false, response: ingestError('unauthorized', UNAUTHORIZED_MESSAGE) };
  if (!insightsEnabledFor(env, auth.learner)) return { ok: false, response: ingestError('feature_off', FEATURE_OFF_MESSAGE) };
  if (!(await allowByLimiter(env, 'RL_WRITE_LEARNER', `ingest:${auth.learner.id}`))) {
    return { ok: false, response: ingestError('rate_limited', INGEST_RATE_LIMITED_MESSAGE) };
  }
  try {
    await touchToken(env.DB, auth, now);
  } catch (err) {
    // Bookkeeping only: a failed last_used_at update must not reject the upload.
    console.error('insights token touch failed', err instanceof Error ? err.message : 'error');
  }
  return { ok: true, value: auth };
}
