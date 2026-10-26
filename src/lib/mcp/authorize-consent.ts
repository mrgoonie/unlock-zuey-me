/**
 * /authorize (MCP OAuth consent) logic, kept out of the Astro page so it can be tested.
 *
 * GET: the library validates the client and redirect URI (parseAuthRequest); a signed-in MEMBER is
 * required (others go through Sign in with zuey.me and come back); then a browser-bound consent handle is
 * created (beginConsent: __Host- cookie, no framing).
 * POST: the handle is redeemed once (approveConsent/denyConsent) and the grant is issued to the learner,
 * with props {learnerId} encrypted into the token. Nothing trusted is read from the form except the handle
 * and the user's scope choice (restricted to our scopes).
 */
import {
  AuthorizationError, CimdFetchError, type ConsentDescription, type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import type { LearnerContext } from '../learning/types';
import type { McpProps } from './mcp-api-handler';
import { consentScopes, isMcpScope, type McpScope } from './mcp-scopes';

export type AuthorizeOutcome =
  | { kind: 'redirect'; location: string; headers: Headers }
  | { kind: 'consent'; details: ConsentDescription; handle: string; scopes: McpScope[]; headers: Headers }
  | { kind: 'error'; status: number; title: string; detail: string | null };

const redirect = (location: string, headers = new Headers()): AuthorizeOutcome => {
  headers.set('Location', location);
  headers.set('Cache-Control', 'no-store');
  return { kind: 'redirect', location, headers };
};

const isMember = (l: LearnerContext | undefined): l is LearnerContext => l?.kind === 'member';

function fromError(err: unknown): AuthorizeOutcome {
  if (err instanceof AuthorizationError && err.redirectTo) return redirect(err.redirectTo);
  if (err instanceof AuthorizationError) {
    return { kind: 'error', status: 400, title: 'Yêu cầu kết nối không hợp lệ hoặc đã hết hạn', detail: err.description };
  }
  if (err instanceof CimdFetchError) {
    return { kind: 'error', status: 400, title: 'Không xác minh được ứng dụng đang xin quyền', detail: null };
  }
  throw err; // KV outage or a bug: let it surface as a 500.
}

export async function authorizeGet(oauth: OAuthHelpers, request: Request, learner: LearnerContext | undefined): Promise<AuthorizeOutcome> {
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    if (!isMember(learner)) {
      const url = new URL(request.url);
      return redirect(`/auth/zuey/login?return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
    }
    const details = await oauth.describeConsent(authRequest); // first: a failed lookup leaves nothing in KV
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set('Cache-Control', 'no-store');
    return { kind: 'consent', details, handle: consent.handle, scopes: consentScopes(details.scope), headers: consent.headers };
  } catch (err) {
    return fromError(err);
  }
}

export async function authorizePost(oauth: OAuthHelpers, request: Request, learner: LearnerContext | undefined): Promise<AuthorizeOutcome> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { kind: 'error', status: 400, title: 'Yêu cầu kết nối không hợp lệ hoặc đã hết hạn', detail: null };
  }
  try {
    const handle = String(form.get('handle') ?? '');
    if (!isMember(learner)) {
      return { kind: 'error', status: 403, title: 'Bạn cần đăng nhập zuey.me để cấp quyền', detail: null };
    }
    const scopes = [...new Set(form.getAll('scope').map(String).filter(isMcpScope))];
    if (form.get('decision') !== 'approve' || scopes.length === 0) {
      const denied = await oauth.denyConsent(request, handle);
      return redirect(denied.redirectTo, denied.headers);
    }
    const approved = await oauth.approveConsent(request, handle, { scope: scopes });
    const props: McpProps = { learnerId: learner.id };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request, // recovered from storage, never from the form
      userId: learner.id,
      metadata: { clientId: approved.request.clientId, grantedAt: new Date().toISOString() },
      scope: scopes,
      props,
    });
    return redirect(redirectTo, approved.headers);
  } catch (err) {
    return fromError(err);
  }
}
