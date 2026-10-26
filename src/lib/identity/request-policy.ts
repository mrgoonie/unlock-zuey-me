/**
 * Pure request policies used by src/middleware.ts: which paths get a learner session, the same-origin rule
 * for state-changing requests, and the security headers added to HTML responses.
 */

/**
 * - `none`: never touch the session (machine endpoints, assets).
 * - `read`: resolve an existing session but never create a guest.
 * - `create`: resolve, or lazily create a guest learner + session.
 */
export type LearnerPolicy = 'none' | 'read' | 'create';

const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|lighthouse|curl\/|wget|python-requests|httpclient|go-http-client|okhttp|axios|node-fetch|undici/i;

export const isBotUserAgent = (ua: string | null): boolean => !ua || BOT_UA.test(ua);

/** A last path segment with a file extension (sw.js, manifest.webmanifest, icon.svg ...). */
const looksLikeStaticAsset = (pathname: string) => /\/[^/]+\.[a-z0-9]{1,12}$/i.test(pathname);

const startsWithSegment = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export const isApiV1 = (pathname: string) => startsWithSegment(pathname, '/api/v1');

export function learnerPolicy(pathname: string, method: string, userAgent: string | null): LearnerPolicy {
  if (
    startsWithSegment(pathname, '/_astro') || startsWithSegment(pathname, '/.well-known') ||
    startsWithSegment(pathname, '/mcp') || pathname === '/api/health'
  ) return 'none';
  if (isApiV1(pathname)) return isBotUserAgent(userAgent) ? 'read' : 'create';
  if (startsWithSegment(pathname, '/oauth') || looksLikeStaticAsset(pathname)) return 'none';
  if (
    pathname === '/' || startsWithSegment(pathname, '/certificates') || startsWithSegment(pathname, '/authorize') ||
    (startsWithSegment(pathname, '/auth') && pathname !== '/auth/zuey/login')
  ) return 'read';
  if (method !== 'GET' && method !== 'POST') return 'read';
  // /auth/zuey/login binds the login request to the browser's learner, so it may create a guest too.
  return isBotUserAgent(userAgent) ? 'read' : 'create';
}

export const isStateChangingMethod = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

/**
 * Same-origin rule for state-changing requests. A present Origin must equal the public site origin or the
 * request's own origin. Without Origin (non-browser clients, which cannot carry a victim's cookie in a CSRF),
 * a Sec-Fetch-Site header, if present, must say same-origin or none.
 */
export function isSameOriginRequest(request: Request, publicSiteUrl: string | undefined): boolean {
  const own = new URL(request.url).origin;
  let site: string | null = null;
  try {
    site = publicSiteUrl ? new URL(publicSiteUrl).origin : null;
  } catch {
    site = null;
  }
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === own || (site !== null && origin === site);
  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite === null || fetchSite === 'same-origin' || fetchSite === 'none';
}

/**
 * CSP for Astro SSR + React islands (Astro emits inline hydration scripts and styles) and Google Fonts.
 * No form-action: the /authorize consent form must be allowed to redirect to the MCP client's redirect URI.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const BASE_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export const HTML_SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
};

/** Adds security headers; clones the response when its headers are immutable (redirects, asset fetches). */
export function withSecurityHeaders(response: Response, options: { csp: boolean }): Response {
  const isHtml = (response.headers.get('content-type') ?? '').includes('text/html');
  const apply = (headers: Headers) => {
    for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
    if (!isHtml) return;
    for (const [k, v] of Object.entries(HTML_SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
    // Appended, not replaced: a page-specific CSP (e.g. the consent page's) stays enforced alongside ours.
    if (options.csp) headers.append('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  };
  try {
    apply(response.headers);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    apply(copy.headers);
    return copy;
  }
}
