/** Type declarations for redact.mjs, so strict TypeScript (astro check, vitest) can import the plain JS module. */

/** Longest input (UTF-16 code units) one call redacts; anything after it is dropped. */
export declare const REDACT_MAX_INPUT: number;

/**
 * Kinds reported by the rules. The wire contract accepts any `[a-z_]{1,32}` kind so a newer client never
 * fails validation on an older server.
 */
export type RedactionKind =
  | 'private_key' | 'ingest_token' | 'api_key' | 'github_token' | 'aws_key' | 'aws_secret' | 'slack_token'
  | 'google_key' | 'jwt' | 'bearer' | 'url_secret' | 'secret' | 'email' | 'home_path' | 'national_id'
  | 'card' | 'phone' | 'iban' | 'ip' | 'high_entropy';

export interface RedactTextResult {
  text: string;
  /** Number of replacements made. */
  count: number;
  /** Distinct kinds replaced, sorted. */
  kinds: RedactionKind[];
}

export interface RedactValueResult<T = unknown> {
  value: T;
  count: number;
  kinds: RedactionKind[];
}

/** Replaces secrets and personal data with `[REDACTED:<kind>]` (home paths with `~`). Idempotent. */
export declare function redactText(text: string): RedactTextResult;

/** Redacts every string inside a JSON-like value; keys are kept. Values nested deeper than 16 levels become null. */
export declare function redactValue<T = unknown>(value: T): RedactValueResult<T>;
