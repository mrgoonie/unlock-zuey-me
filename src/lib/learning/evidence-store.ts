/**
 * Evidence screenshots in R2 (EVIDENCE). Keys are `ev/<learnerId>/<id>.<ext>`, so ownership is part of the
 * key and checked on every use. Only real images (magic bytes sniffed, not the client's content-type) up to
 * 5 MB are accepted. Reads are allowed for the owner, or an admin while the owner's observer consent is on
 * (checked against the database at request time, so revoking consent hides evidence immediately).
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

/** Every key must belong to the learner and exist in R2. */
export async function assertOwnedEvidenceKeys(env: Env, learnerId: string, keys: string[]): Promise<void> {
  if (keys.length > MAX_IMAGES_PER_SUBMISSION) throw new LearningError('invalid', `Tối đa ${MAX_IMAGES_PER_SUBMISSION} ảnh cho mỗi lần nộp.`);
  for (const key of keys) {
    if (evidenceKeyOwner(key) !== learnerId) throw new LearningError('invalid', 'Ảnh đính kèm không hợp lệ.');
    const head = await env.EVIDENCE.head(key);
    if (!head) throw new LearningError('invalid', 'Không tìm thấy ảnh đính kèm. Hãy tải ảnh lên lại.');
  }
}

async function ownerConsents(db: D1Database, ownerId: string): Promise<boolean> {
  const row = await db.prepare('SELECT observer_consent FROM learners WHERE id = ? AND deleted_at IS NULL').bind(ownerId).first<{ observer_consent: number }>();
  return row?.observer_consent === 1;
}

export async function readEvidence(env: Env, viewer: LearnerContext, key: string): Promise<R2ObjectBody> {
  const owner = evidenceKeyOwner(key);
  const notFound = new LearningError('not_found', 'Không tìm thấy ảnh.');
  if (!owner) throw notFound;
  const allowed = owner === viewer.id || (viewer.isAdmin && (await ownerConsents(env.DB, owner)));
  if (!allowed) throw notFound;
  const obj = await env.EVIDENCE.get(key);
  if (!obj) throw notFound;
  return obj;
}
