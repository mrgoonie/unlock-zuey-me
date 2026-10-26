/**
 * Small WebCrypto helpers for identity: random opaque tokens (session cookie, OAuth state, PKCE verifier),
 * SHA-256 hashing (only token hashes are stored) and the PKCE S256 challenge.
 */

/** base64url without padding (RFC 4648 §5). */
export function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random token with `byteLength` bytes of entropy (default 32 → 43 base64url chars). */
export function randomToken(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/** Lowercase hex SHA-256: the form stored in sessions.token_hash. */
export async function sha256Hex(input: string): Promise<string> {
  let hex = '';
  for (const b of await sha256(input)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** PKCE S256 code challenge for a verifier (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(await sha256(verifier));
}

/** Tokens we mint are base64url; anything else in a cookie or parameter is rejected before hashing. */
export const isWellFormedToken = (value: string | undefined | null): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
