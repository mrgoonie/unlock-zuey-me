/**
 * `POST /api/ingest/v1/turns` after authentication: size cap → strict schema → `sentAt` window → analysis
 * consent → server-side redaction of `turn` (same rules as the hook, defense in depth) → one guarded
 * INSERT into the insight_events queue.
 *
 * The INSERT re-checks analysis consent and the per-learner daily cap inside the statement, so a revoke
 * that lands between the pre-check and the write cannot be outrun. A re-fire with the same idempotency
 * key replaces a still-pending payload; anything else is a no-op answered `duplicate: true`.
 */
import type { z } from 'zod';
import { redactText } from '../../../skills/ai-unlocked/scripts/lib/redact.mjs';
import { json } from '../http/api-response';
import { newId, nowIso } from '../db/ids';
import { getConsents } from './consent-store';
import {
  ASSISTANT_FINAL_MAX_CHARS, DAILY_INGEST_CAP_PER_LEARNER, INGEST_DEBOUNCE_MS, INGEST_MAX_BYTES, ingestError,
  ingestTurnV1Schema, REDACTION_KINDS_MAX, sentAtWithinWindow, USER_PROMPT_MAX_CHARS, utf8Bytes,
  type IngestAcceptedResponse, type IngestTurnV1,
} from './ingest-contract';
import type { IngestAuth } from './ingest-auth';
import skillPackageManifest from '../../../skills/ai-unlocked/manifest.json';

/** Version of the ingest API reported by `GET /api/ingest/v1/status` (bumped with the wire contract). */
export const INGEST_SERVER_VERSION = '1.0.0';
/** Newest ai-unlocked skill release, reported to `doctor` by the status endpoint (from the shipped skill manifest). */
export const LATEST_SKILL_VERSION: string = skillPackageManifest.version;

export const CONSENT_REQUIRED_MESSAGE = 'Bạn chưa bật (hoặc đã tắt) quyền cho ai-tutor phân tích. Dữ liệu không được lưu.';
const TOO_LARGE_MESSAGE = `Dữ liệu vượt quá ${INGEST_MAX_BYTES} byte.`;
const CLOCK_SKEW_MESSAGE = 'Đồng hồ máy bạn lệch quá 10 phút so với máy chủ. Hãy gửi lại với thời điểm mới.';
const DAILY_CAP_MESSAGE = 'Đã đạt giới hạn lượt gửi hôm nay. Thử lại sau 00:00 UTC.';

/**
 * The queued payload (insight_events.payload_json). Identity, session and timing live in their own columns.
 * `turn` always validates against `ingestTurnV1Schema.shape.turn` (the analyzer reads it that way), and
 * `payload_bytes` is its UTF-8 size (the analyzer's window byte cap).
 */
export interface StoredTurnPayload {
  v: 1;
  adapter: IngestTurnV1['adapter'];
  adapterVersion: string;
  turn: IngestTurnV1['turn'];
  redaction: { count: number; kinds: string[] };
  truncated: boolean;
  stopHookActive: boolean;
}

/**
 * Reads the request body as UTF-8 text, refusing anything over INGEST_MAX_BYTES before it is fully read
 * (a declared Content-Length is checked first; the stream is cancelled once it passes the cap).
 */
export async function readIngestBody(request: Request, maxBytes = INGEST_MAX_BYTES): Promise<{ text: string } | { response: Response }> {
  const tooLarge = () => ({ response: ingestError('payload_too_large', TOO_LARGE_MESSAGE) });
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { response: ingestError('invalid_payload', 'Dữ liệu không phải UTF-8 hợp lệ.') };
  }
}

/** Parses JSON text with a zod schema; the error message names fields and issue codes only, never values. */
export function parseIngestJson<T>(text: string, schema: z.ZodType<T>): { data: T } | { response: Response } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { response: ingestError('invalid_payload', 'Dữ liệu phải là JSON.') };
  }
  const r = schema.safeParse(raw);
  if (r.success) return { data: r.data };
  const detail = r.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.code}`).join('; ');
  return { response: ingestError('invalid_payload', `Dữ liệu không đúng định dạng (${detail}).`.slice(0, 500)) };
}

/** Reads a small JSON body (pairing endpoints) under `maxBytes`, with the ingest error shape for every failure. */
export async function readIngestJson<T>(request: Request, schema: z.ZodType<T>, maxBytes: number): Promise<{ data: T } | { response: Response }> {
  const body = await readIngestBody(request, maxBytes);
  return 'response' in body ? body : parseIngestJson(body.text, schema);
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/**
 * Server-side redaction of `turn` only (the envelope hashes would trip the high-entropy rule). Free text is
 * masked and re-capped, because placeholders can be longer than what they replace. Identifier fields
 * (tool names, MCP tool names, mission and run ids) cannot hold a placeholder and stay schema-valid, so an
 * identifier the rules flag is dropped instead. The stored turn therefore always passes the strict v1 turn
 * schema the analyzer validates it against.
 */
export function sanitizeTurn(turn: IngestTurnV1): { payload: StoredTurnPayload['turn']; count: number; kinds: string[]; clipped: boolean } {
  let count = 0;
  const kinds = new Set<string>();
  const scan = (text: string) => {
    const r = redactText(text);
    count += r.count;
    for (const k of r.kinds) kinds.add(k);
    return r.text;
  };
  /** True when the identifier contains nothing the rules would redact. */
  const clean = (id: string) => scan(id) === id;

  const src = turn.turn;
  const prompt = src.userPrompt === null ? null : scan(src.userPrompt);
  const reply = scan(src.assistantFinal);
  const userPrompt = prompt === null ? null : clip(prompt, USER_PROMPT_MAX_CHARS);
  const assistantFinal = clip(reply, ASSISTANT_FINAL_MAX_CHARS);
  const clipped = userPrompt !== prompt || assistantFinal !== reply;

  const payload: StoredTurnPayload['turn'] = { userPrompt, assistantFinal, tools: src.tools.filter((t) => clean(t.name)) };
  if (src.platform) {
    const { mcpTools, missionId, runId } = src.platform;
    payload.platform = { mcpTools: mcpTools.filter(clean) };
    if (missionId !== undefined) payload.platform.missionId = missionId === null || clean(missionId) ? missionId : null;
    if (runId !== undefined) payload.platform.runId = runId === null || clean(runId) ? runId : null;
  }
  return { payload, count, kinds: [...kinds].sort(), clipped };
}

const utcDayStart = (now: Date) => nowIso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));

/** Validates, redacts and enqueues one turn for the authenticated learner. Returns the HTTP response. */
export async function ingestTurn(env: Env, auth: IngestAuth, bodyText: string, now: Date = new Date()): Promise<Response> {
  if (utf8Bytes(bodyText) > INGEST_MAX_BYTES) return ingestError('payload_too_large', TOO_LARGE_MESSAGE);
  const parsed = parseIngestJson(bodyText, ingestTurnV1Schema);
  if ('response' in parsed) return parsed.response;
  const turn = parsed.data;
  if (!sentAtWithinWindow(turn.sentAt, now)) return ingestError('clock_skew', CLOCK_SKEW_MESSAGE);

  const db = env.DB;
  const learnerId = auth.learner.id;
  if (!(await getConsents(db, learnerId)).analysis) return ingestError('consent_required', CONSENT_REQUIRED_MESSAGE);

  const sanitized = sanitizeTurn(turn);
  const kinds = [...new Set([...turn.redaction.kinds, ...sanitized.kinds])].sort().slice(0, REDACTION_KINDS_MAX);
  const redactions = turn.redaction.count + sanitized.count;
  const payload: StoredTurnPayload = {
    v: 1, adapter: turn.adapter, adapterVersion: turn.adapterVersion, turn: sanitized.payload,
    redaction: { count: redactions, kinds }, truncated: turn.truncated || sanitized.clipped, stopHookActive: turn.stopHookActive,
  };
  const payloadJson = JSON.stringify(payload);
  const id = newId('iev');

  // One statement: consent and daily cap are re-checked by the SELECT that feeds the INSERT.
  const result = await db.prepare(
    `INSERT INTO insight_events (id, learner_id, token_id, idempotency_key, session_ref, source_runtime, adapter_version,
                                 payload_json, payload_bytes, redactions, next_attempt_at, turn_ended_at, received_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
      WHERE EXISTS (SELECT 1 FROM insight_consents WHERE learner_id = ?2 AND analysis = 1)
        AND (SELECT COUNT(*) FROM insight_events WHERE learner_id = ?2 AND received_at >= ?14) < ?15
     ON CONFLICT (learner_id, idempotency_key) DO UPDATE SET
       payload_json = excluded.payload_json, payload_bytes = excluded.payload_bytes, redactions = excluded.redactions
     WHERE insight_events.status = 'pending'`,
  ).bind(
    id, learnerId, auth.tokenId, turn.idempotencyKey, turn.sessionRef, turn.adapter, turn.adapterVersion,
    payloadJson, utf8Bytes(payloadJson), redactions, nowIso(new Date(now.getTime() + INGEST_DEBOUNCE_MS)),
    nowIso(new Date(turn.turnEndedAt)), nowIso(now), utcDayStart(now), DAILY_INGEST_CAP_PER_LEARNER,
  ).run();

  const stored = await db.prepare(
    'SELECT id FROM insight_events WHERE learner_id = ? AND idempotency_key = ?',
  ).bind(learnerId, turn.idempotencyKey).first<{ id: string }>();
  if (result.meta.changes > 0) return accepted(stored?.id !== id);

  // Nothing written: consent was revoked meanwhile, the turn is already past `pending`, or the cap is hit.
  if (!(await getConsents(db, learnerId)).analysis) return ingestError('consent_required', CONSENT_REQUIRED_MESSAGE);
  if (stored) return accepted(true);
  return ingestError('daily_cap', DAILY_CAP_MESSAGE);
}

const accepted = (duplicate: boolean): Response => json({ accepted: true, duplicate } satisfies IngestAcceptedResponse, 202);
