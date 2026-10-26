/**
 * Wire contract between the ai-unlocked skill (Stop hook, CLI) and the ingest API (/api/ingest/v1/**).
 * The human-readable version is docs/insights-ingest-contract.md; this module is the machine-checked one.
 * The skill's payload builder is tested against `ingestTurnV1Schema`, so client/server drift fails CI.
 *
 * Payload v1 is strict: unknown fields are rejected (the client must never send `cwd`, file contents or
 * anything else outside the documented fields). Adding a field means bumping `v`.
 */
import { z } from 'zod';

/** Runtimes with a shipped adapter. Other runtimes use MCP only. */
export const INGEST_ADAPTERS = ['claude-code'] as const;
export type IngestAdapter = (typeof INGEST_ADAPTERS)[number];

/** Hard cap on the raw request body (bytes, UTF-8). Checked before JSON parsing. */
export const INGEST_MAX_BYTES = 32_768;
/** Size the client aims for (trims the assistant text first); the server only enforces INGEST_MAX_BYTES. */
export const CLIENT_TARGET_BYTES = 16_384;
export const USER_PROMPT_MAX_CHARS = 4_000;
export const ASSISTANT_FINAL_MAX_CHARS = 6_000;
export const TOOLS_MAX = 50;
export const TOOL_NAME_MAX_CHARS = 128;
export const MCP_TOOLS_MAX = 20;
export const REDACTION_KINDS_MAX = 32;
/** `sentAt` must be within this many ms of the server clock (replay defense). */
export const SENT_AT_SKEW_MS = 10 * 60_000;
/** Accepted turns per learner per UTC day (counted from insight_events.received_at). */
export const DAILY_INGEST_CAP_PER_LEARNER = 200;
/** An accepted event becomes ready for analysis this long after it was received (per-session debounce). */
export const INGEST_DEBOUNCE_MS = 5 * 60_000;

/** Ingestion token: `aiu_ing_` + 32 random bytes as base64url (43 chars). Only its SHA-256 hex is stored. */
export const INGEST_TOKEN_PREFIX = 'aiu_ing_';
export const INGEST_TOKEN_PATTERN = /^aiu_ing_[A-Za-z0-9_-]{43}$/;
export const INGEST_TOKEN_SCOPE = 'insights:write';
export const INGEST_TOKEN_TTL_DAYS = 90;
export const DEVICE_LABEL_MAX_CHARS = 64;

/** Device pairing (RFC 8628 style). The user code alphabet has no 0/O/1/I. */
export const PAIR_USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_USER_CODE_LENGTH = 8;
/** Display and input format: XXXX-XXXX. Input is upper-cased and may omit the dash (`normalizeUserCode`). */
export const PAIR_USER_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
/** Device code: 32 random bytes as base64url (43 chars). Only its SHA-256 is used as a KV key. */
export const PAIR_DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PAIR_TTL_SECONDS = 600;
/** Interval the client is told to poll at. */
export const PAIR_POLL_INTERVAL_SECONDS = 5;
/** Polls closer together than this for one device code are answered 429 `slow_down`. */
export const PAIR_MIN_POLL_INTERVAL_MS = 4_000;
/** Page where a signed-in learner approves a pairing code. */
export const PAIR_VERIFICATION_PATH = '/insights/pair';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex');
const isoInstant = z.iso.datetime({ offset: true });
const semver = z.string().max(48).regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,32})?$/, 'semver');
const kebabId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'kebab-case id');

const toolUseSchema = z.object({
  /** Tool name as the runtime reports it (`Bash`, `Edit`, `mcp__ai-unlocked__start_mission`); never arguments. */
  name: z.string().min(1).max(TOOL_NAME_MAX_CHARS).regex(/^[A-Za-z0-9_.:-]+$/, 'tool name'),
  /** False when any call of this tool in the turn reported an error. */
  ok: z.boolean(),
  /** Calls of this tool in the turn. */
  count: z.number().int().min(1).max(1_000),
}).strict();

/** Signals that the turn touched unlock.zuey.me itself (its MCP tools or a mission run). */
const platformSchema = z.object({
  /** unlock.zuey.me MCP tool names used in the turn, without the `mcp__<server>__` prefix. */
  mcpTools: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/, 'mcp tool name')).max(MCP_TOOLS_MAX),
  missionId: kebabId.nullable().optional(),
  runId: z.string().regex(/^run_[A-Za-z0-9_-]{1,64}$/, 'run id').nullable().optional(),
}).strict();

export const ingestTurnV1Schema = z.object({
  v: z.literal(1),
  adapter: z.enum(INGEST_ADAPTERS),
  adapterVersion: semver,
  /** sha256 hex of `session_id + ':' + (prompt_id ?? sha256(last_assistant_message))`. Dedupe key per learner. */
  idempotencyKey: sha256Hex,
  /** sha256 hex of `session_id + installSalt`; the raw session id never leaves the machine. */
  sessionRef: sha256Hex,
  sentAt: isoInstant,
  turnEndedAt: isoInstant,
  turn: z.object({
    /** Latest user prompt, redacted; null when the transcript could not be parsed. */
    userPrompt: z.string().max(USER_PROMPT_MAX_CHARS).nullable(),
    /** Final assistant message of the turn (`last_assistant_message`), redacted. */
    assistantFinal: z.string().max(ASSISTANT_FINAL_MAX_CHARS),
    tools: z.array(toolUseSchema).max(TOOLS_MAX),
    platform: platformSchema.optional(),
  }).strict(),
  /** What the client redacted (the server redacts again and adds its own counts). */
  redaction: z.object({
    count: z.number().int().min(0).max(100_000),
    kinds: z.array(z.string().regex(/^[a-z_]{1,32}$/, 'redaction kind')).max(REDACTION_KINDS_MAX),
  }).strict(),
  /** True when the client trimmed text to fit its caps. */
  truncated: z.boolean(),
  /** Claude Code's `stop_hook_active`: this Stop follows a continuation another hook forced. */
  stopHookActive: z.boolean(),
}).strict();

export type IngestTurnV1 = z.infer<typeof ingestTurnV1Schema>;

export const pairStartSchema = z.object({
  label: z.string().trim().min(1).max(DEVICE_LABEL_MAX_CHARS),
  adapter: z.enum(INGEST_ADAPTERS),
}).strict();
export type PairStartRequest = z.infer<typeof pairStartSchema>;

export const pairPollSchema = z.object({ deviceCode: z.string().regex(PAIR_DEVICE_CODE_PATTERN, 'device code') }).strict();
export type PairPollRequest = z.infer<typeof pairPollSchema>;

/** Body of `POST /api/v1/insights/pair/confirm` (web session). */
export const pairConfirmSchema = z.object({
  userCode: z.string().trim().min(8).max(16),
  approve: z.boolean(),
}).strict();
export type PairConfirmRequest = z.infer<typeof pairConfirmSchema>;

/** Upper-cases a typed user code and restores the dash; null when it cannot be a valid code. */
export function normalizeUserCode(input: string): string | null {
  const bare = input.toUpperCase().replace(/[\s-]/g, '');
  if (bare.length !== PAIR_USER_CODE_LENGTH) return null;
  const code = `${bare.slice(0, 4)}-${bare.slice(4)}`;
  return PAIR_USER_CODE_PATTERN.test(code) ? code : null;
}

/** Responses (success bodies). */
export interface IngestAcceptedResponse {
  accepted: true;
  /** True when the idempotency key was already stored (the pending payload may have been replaced). */
  duplicate: boolean;
}

export interface IngestStatusResponse {
  feature: true;
  consents: { analysis: boolean };
  token: { label: string; expiresAt: string };
  serverVersion: string;
  latestSkillVersion: string;
}

export interface PairStartResponse {
  deviceCode: string;
  userCode: string;
  /** Absolute URL of PAIR_VERIFICATION_PATH. */
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

/** 200: the token, returned exactly once. 428 `{status:'pending'}`; 410 `{status:'expired'|'denied'}`. */
export type PairPollResponse =
  | { token: string; expiresAt: string }
  | { status: 'pending' }
  | { status: 'expired' | 'denied' };

/**
 * Machine-readable `reason` added to ingest error bodies: `{ error: { code, message, reason } }`. The hook
 * branches on it (e.g. `consent_required` and `feature_off` stop uploads and back off; `unauthorized` marks
 * the credentials invalid).
 */
export const INGEST_ERROR_REASONS = {
  /** 401: token missing, malformed, unknown, revoked or expired. */
  unauthorized: { status: 401, code: 'unauthorized' },
  /** 403: analysis consent is off. */
  consent_required: { status: 403, code: 'forbidden' },
  /** 403: a browser Origin header is present (ingest is for non-browser clients only). */
  origin_forbidden: { status: 403, code: 'forbidden' },
  /** 404: INSIGHTS_MODE does not enable the feature for this learner. */
  feature_off: { status: 404, code: 'not_found' },
  /** 400: body is not JSON or fails `ingestTurnV1Schema`. */
  invalid_payload: { status: 400, code: 'invalid' },
  /** 400: body is larger than INGEST_MAX_BYTES (413 is not used so every client error is one code). */
  payload_too_large: { status: 400, code: 'invalid' },
  /** 400: `sentAt` is outside ±SENT_AT_SKEW_MS of the server clock. */
  clock_skew: { status: 400, code: 'invalid' },
  /** 429: request rate limit (per IP or per learner). */
  rate_limited: { status: 429, code: 'rate_limited' },
  /** 429: DAILY_INGEST_CAP_PER_LEARNER reached for today (UTC). */
  daily_cap: { status: 429, code: 'budget_exceeded' },
  /** 429: pairing poll faster than PAIR_MIN_POLL_INTERVAL_MS. */
  slow_down: { status: 429, code: 'rate_limited' },
} as const satisfies Record<string, { status: number; code: string }>;

export type IngestErrorReason = keyof typeof INGEST_ERROR_REASONS;

export interface IngestErrorBody {
  error: { code: (typeof INGEST_ERROR_REASONS)[IngestErrorReason]['code']; message: string; reason: IngestErrorReason };
}

/** Ingest error response with the shared `{error:{code,message}}` shape plus `reason`. */
export function ingestError(reason: IngestErrorReason, message: string): Response {
  const { status, code } = INGEST_ERROR_REASONS[reason];
  const body: IngestErrorBody = { error: { code, message, reason } };
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/** Size of `text` in UTF-8 bytes. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/** True when `sentAt` (ISO) is within ±SENT_AT_SKEW_MS of `now`. */
export function sentAtWithinWindow(sentAt: string, now: Date): boolean {
  const t = Date.parse(sentAt);
  return Number.isFinite(t) && Math.abs(t - now.getTime()) <= SENT_AT_SKEW_MS;
}
