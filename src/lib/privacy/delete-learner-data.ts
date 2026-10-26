/**
 * Right to erasure ("xoá dữ liệu của tôi"): removes every row the learner owns (and guest rows merged into
 * them) in one atomic D1 batch, plus their evidence images in R2. Idempotent: running it again for an
 * already-deleted learner deletes nothing and succeeds.
 *
 * The learner's /mcp OAuth grants (and their tokens) live in KV, outside D1, so they are revoked here too;
 * otherwise a connected MCP client would keep a valid token for an erased account.
 *
 * R2 objects go first: if the D1 batch then fails, a retry still finds the remaining rows; images are
 * found by prefix, so nothing is orphaned either way.
 */
import { listR2Keys } from './export-learner-data';
import { evidencePrefix, LEARNER_TABLES, ownedLearnerIds } from './learner-data-tables';

export interface DeleteResult {
  rowsDeleted: number;
  imagesDeleted: number;
  grantsRevoked: number;
}

/** The slice of the OAuth provider helpers this module needs (`getOAuthHelpers(env)` satisfies it). */
export interface OAuthGrantRevoker {
  listUserGrants(userId: string, options?: { limit?: number; cursor?: string }): Promise<{ items: { id: string }[]; cursor?: string }>;
  revokeGrant(grantId: string, userId: string): Promise<void>;
}

/** Revokes every grant of `userId`, paging until the list is exhausted. Returns how many were revoked. */
export async function revokeAllOAuthGrants(oauth: OAuthGrantRevoker, userId: string): Promise<number> {
  let revoked = 0;
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { limit: 100, cursor });
    for (const grant of page.items) {
      await oauth.revokeGrant(grant.id, userId);
      revoked++;
    }
    cursor = page.cursor;
  } while (cursor);
  return revoked;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export async function deleteLearnerData(db: D1Database, bucket: R2Bucket | undefined, learnerId: string, oauth?: OAuthGrantRevoker): Promise<DeleteResult> {
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

  let grantsRevoked = 0;
  if (oauth) for (const id of ids) grantsRevoked += await revokeAllOAuthGrants(oauth, id);

  const inList = placeholders(ids.length);
  const statements = [
    ...LEARNER_TABLES.map((t) => db.prepare(`DELETE FROM ${t.table} WHERE ${t.column} IN (${inList})`).bind(...ids)),
    db.prepare(`DELETE FROM learners WHERE id IN (${inList})`).bind(...ids),
  ];
  const results = await db.batch(statements);
  const rowsDeleted = results.reduce((n, r) => n + Number(r.meta?.changes ?? 0), 0);
  return { rowsDeleted, imagesDeleted, grantsRevoked };
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
