/**
 * Evidence screenshots in R2 (EVIDENCE). Keys are `ev/<uploaderId>/<id>.<ext>`, so the uploader is part of
 * the key and checked on every use. Only real images (magic bytes sniffed, not the client's content-type) up
 * to 5 MB are accepted.
 *
 * Ownership follows the guest → member merge chain: a key uploaded by a guest that was later merged into a
 * member belongs to that member (the R2 object keeps its guest prefix). Reads and re-submission are allowed
 * for the resolved owner; admins may read while the resolved owner's observer consent is on (checked against
 * the database at request time, so revoking consent hides evidence immediately).
 */
import { newId } from '../db/ids';
import { LearningError, type LearnerContext } from './types';

export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_SUBMISSION = 5;

const KEY_RE = /^ev\/([A-Za-z0-9_-]{1,80})\/([A-Za-z0-9_-]{1,80})\.(png|jpg|webp|gif)$/;

export interface SniffedImage { mime: string; ext: 'png' | 'jpg' | 'webp' | 'gif' }

const startsWith = (b: Uint8Array, sig: number[], offset = 0): boolean => sig.every((v, i) => b[offset + i] === v);

export function sniffImage(b: Uint8Array): SniffedImage | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return { mime: 'image/webp', ext: 'webp' };
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return { mime: 'image/gif', ext: 'gif' };
  return null;
}

export const evidenceKeyOwner = (key: string): string | null => KEY_RE.exec(key)?.[1] ?? null;

export async function storeEvidenceImage(env: Env, learner: LearnerContext, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0) throw new LearningError('invalid', 'Tệp ảnh trống.');
  if (bytes.byteLength > EVIDENCE_MAX_BYTES) throw new LearningError('invalid', 'Ảnh quá lớn (tối đa 5 MB).');
  const img = sniffImage(bytes);
  if (!img) throw new LearningError('invalid', 'Chỉ nhận ảnh PNG, JPG, WebP hoặc GIF.');
  const key = `ev/${learner.id}/${newId('img')}.${img.ext}`;
  try {
    await env.EVIDENCE.put(key, bytes, { httpMetadata: { contentType: img.mime }, customMetadata: { learnerId: learner.id } });
  } catch (err) {
    console.error('evidence put failed', err);
    throw new LearningError('unavailable', 'Chưa tải ảnh lên được. Vui lòng thử lại.');
  }
  return key;
}

/**
 * The active learner who owns keys uploaded by `uploaderId`: the uploader itself, or the member a merged
 * guest uploader was folded into. Null when that learner is unknown or deleted.
 */
async function resolveKeyOwner(db: D1Database, uploaderId: string): Promise<{ id: string; consent: boolean } | null> {
  const row = await db.prepare(
    `SELECT COALESCE(m.id, l.id) AS id, COALESCE(m.observer_consent, l.observer_consent) AS consent
       FROM learners l LEFT JOIN learners m ON m.id = l.merged_into
      WHERE l.id = ? AND (l.merged_into IS NULL OR m.id IS NOT NULL)
        AND (CASE WHEN l.merged_into IS NULL THEN l.deleted_at ELSE m.deleted_at END) IS NULL`,
  ).bind(uploaderId).first<{ id: string; consent: number }>();
  return row ? { id: row.id, consent: row.consent === 1 } : null;
}

/** Every key must belong to the learner (directly or through a merged guest) and exist in R2. */
export async function assertOwnedEvidenceKeys(env: Env, learnerId: string, keys: string[]): Promise<void> {
  if (keys.length > MAX_IMAGES_PER_SUBMISSION) throw new LearningError('invalid', `Tối đa ${MAX_IMAGES_PER_SUBMISSION} ảnh cho mỗi lần nộp.`);
  const owned = new Map<string, boolean>([[learnerId, true]]);
  for (const key of keys) {
    const uploader = evidenceKeyOwner(key);
    if (uploader && !owned.has(uploader)) owned.set(uploader, (await resolveKeyOwner(env.DB, uploader))?.id === learnerId);
    if (!uploader || !owned.get(uploader)) throw new LearningError('invalid', 'Ảnh đính kèm không hợp lệ.');
    const head = await env.EVIDENCE.head(key);
    if (!head) throw new LearningError('invalid', 'Không tìm thấy ảnh đính kèm. Hãy tải ảnh lên lại.');
  }
}

export async function readEvidence(env: Env, viewer: LearnerContext, key: string): Promise<R2ObjectBody> {
  const uploader = evidenceKeyOwner(key);
  const notFound = new LearningError('not_found', 'Không tìm thấy ảnh.');
  if (!uploader) throw notFound;
  let allowed = uploader === viewer.id;
  if (!allowed) {
    const owner = await resolveKeyOwner(env.DB, uploader);
    allowed = !!owner && (owner.id === viewer.id || (viewer.isAdmin && owner.consent));
  }
  if (!allowed) throw notFound;
  const obj = await env.EVIDENCE.get(key);
  if (!obj) throw notFound;
  return obj;
}
