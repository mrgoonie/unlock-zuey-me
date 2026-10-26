/**
 * Device pairing (RFC 8628 style) for the ai-unlocked CLI, kept in the KV `CACHE` namespace:
 *
 * - `insights:pair:dev:<sha256(deviceCode)>` → PairingRecord (the device code itself is never stored)
 * - `insights:pair:user:<userCode>` → the device hash
 * - `insights:pair:poll:<sha256(deviceCode)>` → time of the last poll (slow_down), kept apart from the
 *   record so a poll can never overwrite an approval written at the same moment
 *
 * All expire after PAIR_TTL_SECONDS; the record also carries `expiresAt`, which is what is enforced (KV TTLs
 * are a cleanup mechanism, not a clock). On an approved poll both pairing keys are deleted *before* the
 * token is minted, so the token is handed out once.
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
  label: string;
  adapter: IngestAdapter;
  status: PairingStatus;
  learnerId?: string;
  createdAt: string;
  expiresAt: string;
}

const KEY_PREFIX = 'insights:pair:';
const devKey = (deviceHash: string) => `${KEY_PREFIX}dev:${deviceHash}`;
const userKey = (userCode: string) => `${KEY_PREFIX}user:${userCode}`;
const pollKey = (deviceHash: string) => `${KEY_PREFIX}poll:${deviceHash}`;
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

async function readRecord(kv: KVNamespace, deviceHash: string): Promise<PairingRecord | null> {
  const raw = await kv.get(devKey(deviceHash));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PairingRecord;
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
  const deviceCode = randomToken(32);
  const deviceHash = await sha256Hex(deviceCode);
  // A live collision among 32^8 codes is very unlikely; retry a few times rather than overwrite one.
  let userCode = generateUserCode();
  for (let i = 0; i < 4 && (await kv.get(userKey(userCode))) !== null; i++) userCode = generateUserCode();
  const record: PairingRecord = {
    userCode, label: input.label, adapter: input.adapter, status: 'pending',
    createdAt: nowIso(now), expiresAt: nowIso(new Date(now.getTime() + PAIR_TTL_SECONDS * 1000)),
  };
  await kv.put(devKey(deviceHash), JSON.stringify(record), { expirationTtl: PAIR_TTL_SECONDS });
  await kv.put(userKey(userCode), deviceHash, { expirationTtl: PAIR_TTL_SECONDS });
  return {
    deviceCode, userCode,
    verificationUri: new URL(PAIR_VERIFICATION_PATH, siteOrigin).toString(),
    interval: PAIR_POLL_INTERVAL_SECONDS, expiresIn: PAIR_TTL_SECONDS,
  };
}

async function findByUserCode(kv: KVNamespace, typedCode: string, now: Date): Promise<{ deviceHash: string; record: PairingRecord } | null> {
  const userCode = normalizeUserCode(typedCode);
  if (!userCode) return null;
  const deviceHash = await kv.get(userKey(userCode));
  if (!deviceHash) return null;
  const record = await readRecord(kv, deviceHash);
  if (!record || record.userCode !== userCode || !isLive(record, now)) return null;
  return { deviceHash, record };
}

/** Label and adapter of a pending pairing, for the approval page. Null when unknown, expired or decided. */
export async function peekPairing(
  kv: KVNamespace, typedCode: string, now: Date = new Date(),
): Promise<Pick<PairingRecord, 'userCode' | 'label' | 'adapter' | 'expiresAt'> | null> {
  const found = await findByUserCode(kv, typedCode, now);
  if (!found || found.record.status !== 'pending') return null;
  const { userCode, label, adapter, expiresAt } = found.record;
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
  if (!found || found.record.status !== 'pending') return false;
  const next: PairingRecord = { ...found.record, status: approve ? 'approved' : 'denied', learnerId };
  await kv.put(devKey(found.deviceHash), JSON.stringify(next), { expirationTtl: remainingTtl(found.record, now) });
  return true;
}

export type PollOutcome =
  | { kind: 'token'; token: string; expiresAt: string }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'denied' };

async function forget(kv: KVNamespace, deviceHash: string, record: PairingRecord): Promise<void> {
  await Promise.all([kv.delete(devKey(deviceHash)), kv.delete(userKey(record.userCode))]);
}

/**
 * One poll by the CLI. Polls closer than PAIR_MIN_POLL_INTERVAL_MS apart get `slow_down`. An unknown or
 * expired device code is `expired`. On approval both keys are deleted first, then the token is minted;
 * when the learner can no longer hold a token (deleted, not a member) the pairing is `expired`.
 */
export async function pollPairing(kv: KVNamespace, db: D1Database, deviceCode: string, now: Date = new Date()): Promise<PollOutcome> {
  const deviceHash = await sha256Hex(deviceCode);
  const last = Number(await kv.get(pollKey(deviceHash)));
  if (Number.isFinite(last) && last > 0 && now.getTime() - last < PAIR_MIN_POLL_INTERVAL_MS) return { kind: 'slow_down' };
  await kv.put(pollKey(deviceHash), String(now.getTime()), { expirationTtl: KV_MIN_TTL_SECONDS });

  const record = await readRecord(kv, deviceHash);
  if (!record) return { kind: 'expired' };
  if (!isLive(record, now)) {
    await forget(kv, deviceHash, record);
    return { kind: 'expired' };
  }
  if (record.status === 'pending') return { kind: 'pending' };
  await forget(kv, deviceHash, record);
  if (record.status === 'denied' || !record.learnerId) return { kind: 'denied' };
  const created = await createToken(db, record.learnerId, record.label, record.adapter, now);
  return created ? { kind: 'token', token: created.token, expiresAt: created.expiresAt } : { kind: 'expired' };
}
