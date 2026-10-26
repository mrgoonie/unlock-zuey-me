/**
 * The two halves of "Sign in with zuey.me", kept out of the Astro routes so they can be tested:
 * - startSignIn: store state + PKCE verifier bound to the browser's learner, build the authorize URL.
 * - finishSignIn: validate state (single use, same browser), `iss`, exchange the code, read userinfo,
 *   upsert/merge the member and rotate the session.
 * Failures return an error code for the Vietnamese error page; token values never reach logs or URLs.
 */
import { recordEventSafe } from '../observer/events';
import { consumeLoginRequest, createLoginRequest, validateReturnTo } from './login-requests';
import { completeMemberSignIn } from './member-sign-in';
import { getZueyEndpoints, type FetchLike } from './zuey-discovery';
import { buildAuthorizeUrl, exchangeCode, fetchUserinfo, resolveZueyClient, ZueyAuthError } from './zuey-oauth-client';

export type SignInErrorCode =
  | 'cancelled' | 'invalid_state' | 'expired' | 'wrong_browser' | 'issuer_mismatch' | 'upstream' | 'no_learner';

type FlowEnv = Pick<Env, 'DB' | 'CACHE' | 'PUBLIC_SITE_URL' | 'ZUEY_ISSUER'>;
type BrowserLearner = { id: string; kind: 'guest' | 'member' } | null | undefined;

export async function startSignIn(
  env: FlowEnv, input: { requestUrl: URL; learner: BrowserLearner; returnTo: string | null; now?: Date; fetchFn?: FetchLike },
): Promise<{ ok: true; location: string } | { ok: false; error: SignInErrorCode }> {
  if (!input.learner) return { ok: false, error: 'no_learner' };
  const endpoints = await getZueyEndpoints(env.ZUEY_ISSUER, input.fetchFn);
  let client;
  try {
    client = await resolveZueyClient(env, input.requestUrl, endpoints, input.fetchFn);
  } catch (err) {
    console.error('zuey sign-in: client resolution failed', err instanceof Error ? `${err.name}: ${err.message}` : 'error');
    return { ok: false, error: 'upstream' };
  }
  const login = await createLoginRequest(env.DB, {
    learnerId: input.learner.id, returnTo: validateReturnTo(input.returnTo), now: input.now ?? new Date(),
  });
  return { ok: true, location: buildAuthorizeUrl(endpoints, client, login) };
}

export interface FinishInput {
  requestUrl: URL;
  learner: BrowserLearner;
  sessionToken: string | undefined;
  now?: Date;
  fetchFn?: FetchLike;
}

export type FinishResult =
  | { ok: true; sessionToken: string; returnTo: string; memberId: string }
  | { ok: false; error: SignInErrorCode };

export async function finishSignIn(env: FlowEnv, input: FinishInput): Promise<FinishResult> {
  const now = input.now ?? new Date();
  const params = input.requestUrl.searchParams;
  // Consume first: the state is single use even when the provider reports an error.
  const consumed = await consumeLoginRequest(env.DB, params.get('state'), now);
  if (!consumed.ok) return { ok: false, error: consumed.reason };
  const login = consumed.request;
  // Login CSRF guard: the callback must arrive in the browser (session) that started the login.
  if (!input.learner || input.learner.id !== login.learnerId) return { ok: false, error: 'wrong_browser' };
  if (params.get('error')) return { ok: false, error: 'cancelled' };

  const endpoints = await getZueyEndpoints(env.ZUEY_ISSUER, input.fetchFn);
  const iss = params.get('iss');
  if ((iss !== null && iss !== endpoints.issuer) || (iss === null && endpoints.issParameterRequired)) {
    return { ok: false, error: 'issuer_mismatch' };
  }
  const code = params.get('code');
  if (!code || code.length > 2048) return { ok: false, error: 'invalid_state' };

  try {
    const client = await resolveZueyClient(env, input.requestUrl, endpoints, input.fetchFn);
    const accessToken = await exchangeCode(endpoints, client, { code, codeVerifier: login.codeVerifier }, input.fetchFn);
    const userinfo = await fetchUserinfo(endpoints, accessToken, input.fetchFn);
    const result = await completeMemberSignIn(env.DB, {
      userinfo, current: input.learner, oldSessionToken: input.sessionToken, now,
    });
    await recordEventSafe(env.DB, {
      learnerId: result.memberId, name: 'auth.signed_in',
      props: { new_member: result.newMember, guest: result.guestOutcome, email_verified: userinfo.emailVerified },
    });
    if (result.guestOutcome === 'merged') {
      await recordEventSafe(env.DB, { learnerId: result.memberId, name: 'auth.guest_merged', props: { guest_id: result.guestId } });
    }
    return { ok: true, sessionToken: result.sessionToken, returnTo: login.returnTo, memberId: result.memberId };
  } catch (err) {
    // Only codes and statuses are logged; never the code, verifier or tokens.
    console.error('zuey sign-in failed', err instanceof ZueyAuthError ? `${err.code}: ${err.message}` : err instanceof Error ? `${err.name}: ${err.message}` : 'error');
    return { ok: false, error: 'upstream' };
  }
}
