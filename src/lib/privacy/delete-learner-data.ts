/**
 * Right to erasure ("xoá dữ liệu của tôi"): removes every row the learner owns (and guest rows merged into
 * them) in one atomic D1 batch, plus their evidence images in R2. Idempotent: running it again for an
 * already-deleted learner deletes nothing and succeeds.
 *
 * R2 objects go first: if the D1 batch then fails, a retry still finds the remaining rows; images are
 * found by prefix, so nothing is orphaned either way.
 */
import { listR2Keys } from './export-learner-data';
import { evidencePrefix, LEARNER_TABLES, ownedLearnerIds } from './learner-data-tables';

export interface DeleteResult {
  rowsDeleted: number;
  imagesDeleted: number;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export async function deleteLearnerData(db: D1Database, bucket: R2Bucket | undefined, learnerId: string): Promise<DeleteResult> {
  const ids = await ownedLearnerIds(db, learnerId);

  let imagesDeleted = 0;
  if (bucket) {
    for (const id of ids) {
      const keys = await listR2Keys(bucket, evidencePrefix(id));
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        await bucket.delete(chunk);
        imagesDeleted += chunk.length;
      }
    }
  }

  const inList = placeholders(ids.length);
  const statements = [
    ...LEARNER_TABLES.map((t) => db.prepare(`DELETE FROM ${t.table} WHERE ${t.column} IN (${inList})`).bind(...ids)),
    db.prepare(`DELETE FROM learners WHERE id IN (${inList})`).bind(...ids),
  ];
  const results = await db.batch(statements);
  const rowsDeleted = results.reduce((n, r) => n + Number(r.meta?.changes ?? 0), 0);
  return { rowsDeleted, imagesDeleted };
}

/**
 * Set-Cookie headers expiring every cookie the browser sent. After erasure no app cookie is meaningful,
 * and expiring all of them ends the session without coupling to the identity module's cookie name.
 */
export function expireAllCookies(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const names = new Set<string>();
  for (const part of cookieHeader.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) names.add(name);
  }
  return [...names].map((n) => `${n}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}
