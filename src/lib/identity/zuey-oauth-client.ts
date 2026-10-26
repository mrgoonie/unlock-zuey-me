/**
 * OAuth 2.1 client for "Sign in with zuey.me" (authorization code + PKCE S256, public client).
 *
 * Production uses the Client ID Metadata Document at `<site>/oauth/zuey-client.json` as client_id. That
 * document lists only the production redirect URI, so a loopback dev server registers itself once via
 * Dynamic Client Registration and caches the client_id in KV. zuey.me issues no id_token: identity comes
 * from GET /oauth/userinfo with the access token obtained by our own server-side code exchange.
 */
import { z } from 'zod';
import type { FetchLike, ZueyEndpoints } from './zuey-discovery';

export const ZUEY_SCOPE = 'openid profile email';
export const CALLBACK_PATH = '/auth/zuey/callback';
export const CIMD_PATH = '/oauth/zuey-client.json';

export class ZueyAuthError extends Error {
  constructor(public code: 'registration' | 'token_exchange' | 'userinfo', message: string) {
    super(message);
  }
}

export interface ZueyClient {
  clientId: string;
  redirectUri: string;
}

const isLoopbackHost = (host: string) => host === 'localhost' || host === '127.0.0.1';

export function siteOrigin(publicSiteUrl: string): string {
  return new URL(publicSiteUrl).origin;
}

/** CIMD client for production; a DCR-registered client (cached in KV) for loopback dev servers. */
export async function resolveZueyClient(
  env: Pick<Env, 'PUBLIC_SITE_URL' | 'CACHE'>, requestUrl: URL, endpoints: ZueyEndpoints, fetchFn: FetchLike = fetch,
): Promise<ZueyClient> {
  const site = siteOrigin(env.PUBLIC_SITE_URL);
  if (!isLoopbackHost(requestUrl.hostname)) {
    return { clientId: `${site}${CIMD_PATH}`, redirectUri: `${site}${CALLBACK_PATH}` };
  }
  const redirectUri = `${requestUrl.origin}${CALLBACK_PATH}`;
  const key = `zuey-dcr:${endpoints.issuer}:${redirectUri}`;
  const cached = await env.CACHE.get(key);
  if (cached) return { clientId: cached, redirectUri };
  if (!endpoints.registrationEndpoint) throw new ZueyAuthError('registration', 'issuer has no registration endpoint');
  const res = await fetchFn(endpoints.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'AI Unlocked (local dev)',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      scope: ZUEY_SCOPE,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = res.ok ? z.object({ client_id: z.string().min(1) }).safeParse(await res.json().catch(() => null)) : null;
  if (!body?.success) throw new ZueyAuthError('registration', `client registration failed (${res.status})`);
  await env.CACHE.put(key, body.data.client_id, { expirationTtl: 30 * 24 * 60 * 60 });
  return { clientId: body.data.client_id, redirectUri };
}

/** Authorization URL. Scope is always explicit: omitting it would yield zuey.me's MCP member scopes. */
export function buildAuthorizeUrl(
  endpoints: ZueyEndpoints, client: ZueyClient, input: { state: string; codeChallenge: string },
): string {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('scope', ZUEY_SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

const tokenSchema = z.object({ access_token: z.string().min(1), token_type: z.string() });

/** Exchanges the authorization code (with the PKCE verifier) for an access token. Never logs token values. */
export async function exchangeCode(
  endpoints: ZueyEndpoints, client: ZueyClient, input: { code: string; codeVerifier: string }, fetchFn: FetchLike = fetch,
): Promise<string> {
  const res = await fetchFn(endpoints.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: input.codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ZueyAuthError('token_exchange', `token endpoint returned ${res.status}`);
  const parsed = tokenSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== 'bearer') {
    throw new ZueyAuthError('token_exchange', 'token response is not a bearer token');
  }
  return parsed.data.access_token;
}

export interface ZueyUserinfo {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

const httpsUrl = z.string().max(2048).refine((v) => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
});

const userinfoSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(320).optional().nullable().catch(null),
  email_verified: z.boolean().optional().nullable().catch(null),
  name: z.string().max(200).optional().nullable().catch(null),
  picture: httpsUrl.optional().nullable().catch(null),
});

export async function fetchUserinfo(endpoints: ZueyEndpoints, accessToken: string, fetchFn: FetchLike = fetch): Promise<ZueyUserinfo> {
  const res = await fetchFn(endpoints.userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ZueyAuthError('userinfo', `userinfo returned ${res.status}`);
  const parsed = userinfoSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new ZueyAuthError('userinfo', 'userinfo response is invalid');
  const u = parsed.data;
  return {
    sub: u.sub,
    email: u.email ? u.email.toLowerCase() : null,
    emailVerified: u.email_verified === true,
    name: u.name?.trim() || null,
    picture: u.picture ?? null,
  };
}
