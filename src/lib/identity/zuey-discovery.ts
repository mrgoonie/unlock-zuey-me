/**
 * zuey.me authorization-server discovery (RFC 8414). Endpoints come from
 * `<issuer>/.well-known/oauth-authorization-server`; when that document is unreachable we fall back to the
 * known paths. Every endpoint must be HTTPS on the issuer's origin, so a tampered document cannot point
 * the code exchange (and the PKCE verifier) somewhere else.
 */
import { z } from 'zod';

export interface ZueyEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  registrationEndpoint: string | null;
  /** RFC 9207: when advertised, the callback MUST carry a matching `iss`. */
  issParameterRequired: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: ZueyEndpoints }>();

const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  userinfo_endpoint: z.string().optional(),
  registration_endpoint: z.string().optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});

/** Canonical issuer string (no trailing slash). Throws for a non-HTTPS issuer outside loopback. */
export function normalizeIssuer(raw: string): string {
  const url = new URL(raw);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new Error('ZUEY_ISSUER must be https');
  return url.origin;
}

function sameOriginEndpoint(issuer: string, value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === issuer ? url.toString() : null;
  } catch {
    return null;
  }
}

export function fallbackEndpoints(issuer: string): ZueyEndpoints {
  return {
    issuer,
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    tokenEndpoint: `${issuer}/oauth/token`,
    userinfoEndpoint: `${issuer}/oauth/userinfo`,
    registrationEndpoint: `${issuer}/oauth/register`,
    issParameterRequired: false,
  };
}

/** Parses a metadata document; returns null when it is invalid or names a different issuer. */
export function endpointsFromMetadata(issuer: string, doc: unknown): ZueyEndpoints | null {
  const parsed = metadataSchema.safeParse(doc);
  if (!parsed.success) return null;
  const m = parsed.data;
  if (m.issuer.replace(/\/+$/, '') !== issuer) return null;
  const authorizationEndpoint = sameOriginEndpoint(issuer, m.authorization_endpoint);
  const tokenEndpoint = sameOriginEndpoint(issuer, m.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) return null;
  const fallback = fallbackEndpoints(issuer);
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    userinfoEndpoint: sameOriginEndpoint(issuer, m.userinfo_endpoint) ?? fallback.userinfoEndpoint,
    registrationEndpoint: sameOriginEndpoint(issuer, m.registration_endpoint),
    issParameterRequired: m.authorization_response_iss_parameter_supported === true,
  };
}

/** Discovered endpoints, cached per isolate for an hour (fallbacks are not cached, so recovery is quick). */
export async function getZueyEndpoints(rawIssuer: string, fetchFn: FetchLike = fetch, now = Date.now()): Promise<ZueyEndpoints> {
  const issuer = normalizeIssuer(rawIssuer);
  const hit = cache.get(issuer);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const res = await fetchFn(`${issuer}/.well-known/oauth-authorization-server`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const value = endpointsFromMetadata(issuer, await res.json());
      if (value) {
        cache.set(issuer, { at: now, value });
        return value;
      }
      console.warn('zuey metadata rejected: invalid document or issuer mismatch');
    } else {
      console.warn('zuey metadata unavailable', res.status);
    }
  } catch (err) {
    console.warn('zuey metadata fetch failed', err instanceof Error ? err.name : 'error');
  }
  return fallbackEndpoints(issuer);
}

/** Test hook: forget cached discovery results. */
export const clearZueyDiscoveryCache = () => cache.clear();
