/**
 * Device pairing (RFC 8628 style) for the ai-unlocked CLI, kept in the KV `CACHE` namespace:
 *
 * - `insights:pair:user:<userCode>` → PairingRecord, which holds sha256(deviceCode) (the device code itself
 *   is never stored)
 * - `insights:pair:poll:<sha256(deviceCode)>` → time of the last poll (slow_down), kept apart from the
 *   record so a poll can never overwrite an approval written at the same moment
 *
 * The device code is the 8 user-code characters (no dash) followed by 35 random base64url characters
 * (210 bits), so a poll finds its record from the code alone and `pair/start`, which needs no
 * authentication, costs exactly one KV write. The record is accepted only when the hash of the whole device
 * code matches, so knowing the user code shown on screen does not let anyone poll for the token.
 *
 * All keys expire after PAIR_TTL_SECONDS; the record also carries `expiresAt`, which is what is enforced (KV
 * TTLs are a cleanup mechanism, not a clock). On an approved poll the record is deleted *before* the token is
 * minted, so the token is handed out once.
 */
import { nowIso } from '../db/ids';
import { randomToken, sha256Hex } from '../identity/identity-crypto';
import {
  normalizeUserCode, PAIR_MIN_POLL_INTERVAL_MS, PAIR_POLL_INTERVAL_SECONDS, PAIR_TTL_SECONDS, PAIR_USER_CODE_ALPHABET,
  PAIR_USER_CODE_LENGTH, PAIR_VERIFICATION_PATH, type IngestAdapter, type PairStartResponse,
} from './ingest-contract';
import { createToken } from './ingest-tokens';

export type PairingStatus = 'pending' | 'approved' | 'denied';

export interface PairingRecord {
  userCode: string;
  /** sha256 hex of the full device code. */
  deviceHash: string;
  label: string;
  adapter: IngestAdapter;
  status: PairingStatus;
  learnerId?: string;
  createdAt: string;
  expiresAt: string;
}

const KEY_PREFIX = 'insights:pair:';
const userKey = (userCode: string) => `${KEY_PREFIX}user:${userCode}`;
const pollKey = (deviceHash: string) => `${KEY_PREFIX}poll:${deviceHash}`;
/** Random base64url characters after the user code: 35 × 6 = 210 bits. */
const DEVICE_SECRET_CHARS = 35;
/** Cloudflare KV rejects expirationTtl below 60 seconds. */
const KV_MIN_TTL_SECONDS = 60;

/** Pairing request bodies are tiny; anything bigger is refused unread. */
export const PAIR_BODY_MAX_BYTES = 1_024;

/** Public origin the learner opens; the request's own origin when PUBLIC_SITE_URL is missing or invalid. */
export function siteOrigin(env: Pick<Env, 'PUBLIC_SITE_URL'>, request: Request): string {
  try {
    if (env.PUBLIC_SITE_URL) return new URL(env.PUBLIC_SITE_URL).origin;
  } catch {
    // An invalid PUBLIC_SITE_URL falls back to the request origin below.
  }
  return new URL(request.url).origin;
}

/** 8 characters from the 32-symbol alphabet, formatted XXXX-XXXX. 32 divides 256, so `byte & 31` is unbiased. */
export function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIR_USER_CODE_LENGTH));
  const chars = Array.from(bytes, (b) => PAIR_USER_CODE_ALPHABET[b & 31]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Device code for `userCode`: its 8 characters without the dash, then DEVICE_SECRET_CHARS random ones. */
function deviceCodeFor(userCode: string): string {
  return `${userCode.replace('-', '')}${randomToken(32).slice(0, DEVICE_SECRET_CHARS)}`;
}

/** The user code a device code was issued for, or null when its prefix cannot be one. */
const userCodeOf = (deviceCode: string): string | null => normalizeUserCode(deviceCode.slice(0, PAIR_USER_CODE_LENGTH));

async function readRecord(kv: KVNamespace, userCode: string): Promise<PairingRecord | null> {
  const raw = await kv.get(userKey(userCode));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as Partial<PairingRecord> | null;
    return rec && typeof rec.deviceHash === 'string' && rec.userCode === userCode ? rec as PairingRecord : null;
  } catch {
    return null;
  }
}

const isLive = (rec: PairingRecord, now: Date) => Date.parse(rec.expiresAt) > now.getTime();

const remainingTtl = (rec: PairingRecord, now: Date) =>
  Math.max(KV_MIN_TTL_SECONDS, Math.ceil((Date.parse(rec.expiresAt) - now.getTime()) / 1000));

/** Starts a pairing. `siteOrigin` is the public origin the learner opens (e.g. https://unlock.zuey.me). */
export async function startPairing(
  kv: KVNamespace, input: { label: string; adapter: IngestAdapter }, siteOrigin: string, now: Date = new Date(),
): Promise<PairStartResponse> {
  // A live collision among 32^8 codes is very unlikely; retry a few times (reads only) rather than overwrite one.
  let userCode = generateUserCode();
  for (let i = 0; i < 4 && (await kv.get(userKey(userCode))) !== null; i++) userCode = generateUserCode();
  const deviceCode = deviceCodeFor(userCode);
  const record: PairingRecord = {
    userCode, deviceHash: await sha256Hex(deviceCode), label: input.label, adapter: input.adapter, status: 'pending',
    createdAt: nowIso(now), expiresAt: nowIso(new Date(now.getTime() + PAIR_TTL_SECONDS * 1000)),
  };
  // The only KV write of an unauthenticated start.
  await kv.put(userKey(userCode), JSON.stringify(record), { expirationTtl: PAIR_TTL_SECONDS });
  return {
    deviceCode, userCode,
    verificationUri: new URL(PAIR_VERIFICATION_PATH, siteOrigin).toString(),
    interval: PAIR_POLL_INTERVAL_SECONDS, expiresIn: PAIR_TTL_SECONDS,
  };
}

async function findByUserCode(kv: KVNamespace, typedCode: string, now: Date): Promise<PairingRecord | null> {
  const userCode = normalizeUserCode(typedCode);
  if (!userCode) return null;
  const record = await readRecord(kv, userCode);
  return record && isLive(record, now) ? record : null;
}

/** Label and adapter of a pending pairing, for the approval page. Null when unknown, expired or decided. */
export async function peekPairing(
  kv: KVNamespace, typedCode: string, now: Date = new Date(),
): Promise<Pick<PairingRecord, 'userCode' | 'label' | 'adapter' | 'expiresAt'> | null> {
  const found = await findByUserCode(kv, typedCode, now);
  if (!found || found.status !== 'pending') return null;
  const { userCode, label, adapter, expiresAt } = found;
  return { userCode, label, adapter, expiresAt };
}

/**
 * Approves or denies a pending pairing for `learnerId`. Returns false when the code is malformed, unknown,
 * expired or already decided (the route answers 404 for all of them).
 */
export async function confirmPairing(
  kv: KVNamespace, learnerId: string, typedCode: string, approve: boolean, now: Date = new Date(),
): Promise<boolean> {
  const found = await findByUserCode(kv, typedCode, now);
  if (!found || found.status !== 'pending') return false;
  const next: PairingRecord = { ...found, status: approve ? 'approved' : 'denied', learnerId };
  await kv.put(userKey(found.userCode), JSON.stringify(next), { expirationTtl: remainingTtl(found, now) });
  return true;
}

export type PollOutcome =
  | { kind: 'token'; token: string; expiresAt: string }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'denied' };

const forget = (kv: KVNamespace, record: PairingRecord): Promise<void> => kv.delete(userKey(record.userCode));

/**
 * One poll by the CLI. An unknown device code (no record for its user-code prefix, or a record whose device
 * hash differs) is `expired` without any KV write (random codes from an unauthenticated client must not burn
 * the KV write quota). Polls of a known code closer than PAIR_MIN_POLL_INTERVAL_MS apart get `slow_down`; an
 * expired code is `expired`. On approval the pairing record is deleted first, then the token is minted; when
 * the learner can no longer hold a token (deleted, not a member) the pairing is `expired`.
 */
export async function pollPairing(kv: KVNamespace, db: D1Database, deviceCode: string, now: Date = new Date()): Promise<PollOutcome> {
  const userCode = userCodeOf(deviceCode);
  if (!userCode) return { kind: 'expired' };
  const deviceHash = await sha256Hex(deviceCode);
  const record = await readRecord(kv, userCode);
  if (!record || record.deviceHash !== deviceHash) return { kind: 'expired' };

  const last = Number(await kv.get(pollKey(deviceHash)));
  if (Number.isFinite(last) && last > 0 && now.getTime() - last < PAIR_MIN_POLL_INTERVAL_MS) return { kind: 'slow_down' };
  await kv.put(pollKey(deviceHash), String(now.getTime()), { expirationTtl: KV_MIN_TTL_SECONDS });
  if (!isLive(record, now)) {
    await forget(kv, record);
    return { kind: 'expired' };
  }
  if (record.status === 'pending') return { kind: 'pending' };
  await forget(kv, record);
  if (record.status === 'denied' || !record.learnerId) return { kind: 'denied' };
  const created = await createToken(db, record.learnerId, record.label, record.adapter, now);
  return created ? { kind: 'token', token: created.token, expiresAt: created.expiresAt } : { kind: 'expired' };
}
