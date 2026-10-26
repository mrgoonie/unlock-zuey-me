/**
 * Resolves the learner for one request from its session cookie, creating a guest + session lazily when the
 * route's policy allows it. Returns what the middleware must do with the cookie.
 */
import type { LearnerContext } from '../learning/types';
import { guestInsert, parseAdminEmails, toLearnerContext } from './learner-repository';
import type { LearnerPolicy } from './request-policy';
import { resolveSession, sessionInsert, touchSession } from './session-store';

export interface RequestLearner {
  learner: LearnerContext | null;
  /** Token to (re-)send in the cookie: new session or sliding refresh. */
  setCookieToken: string | null;
  /** The presented cookie is invalid and should be cleared. */
  clearCookie: boolean;
  /** A guest was needed but `allowGuestCreation` refused it (per-IP limit). */
  guestThrottled?: boolean;
}

export async function resolveRequestLearner(
  env: Pick<Env, 'DB' | 'ADMIN_EMAILS'>,
  input: {
    token: string | undefined;
    policy: LearnerPolicy;
    now: Date;
    /** Asked only when a new guest would be created; false leaves the request without a learner. */
    allowGuestCreation?: () => Promise<boolean>;
  },
): Promise<RequestLearner> {
  const { token, policy, now } = input;
  if (policy === 'none') return { learner: null, setCookieToken: null, clearCookie: false };
  const admins = parseAdminEmails(env.ADMIN_EMAILS);

  const resolved = token ? await resolveSession(env.DB, token, now) : null;
  if (resolved) {
    if (resolved.needsRefresh) await touchSession(env.DB, resolved.sessionId, now);
    return {
      learner: toLearnerContext(resolved.learner, admins),
      setCookieToken: resolved.needsRefresh ? (token as string) : null,
      clearCookie: false,
    };
  }
  if (policy !== 'create') return { learner: null, setCookieToken: null, clearCookie: !!token };
  if (input.allowGuestCreation && !(await input.allowGuestCreation())) {
    return { learner: null, setCookieToken: null, clearCookie: !!token, guestThrottled: true };
  }

  const guest = guestInsert(env.DB, now);
  const session = await sessionInsert(env.DB, guest.row.id, now);
  await env.DB.batch([guest.stmt, session.stmt]);
  return { learner: toLearnerContext(guest.row, admins), setCookieToken: session.token, clearCookie: false };
}
