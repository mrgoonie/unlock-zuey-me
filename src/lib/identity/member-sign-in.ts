/**
 * Completes a verified "Sign in with zuey.me": upserts the member by zuey `sub`, carries the browser's guest
 * progress over, and rotates the session. Everything is one atomic D1 batch.
 *
 * - No member yet for this sub and the browser is a guest: the guest row itself is promoted to member, so
 *   all its progress stays in place.
 * - Member exists and the browser is a (different) guest: the guest is merged into the member.
 * - Browser already signed in (member): only the session switches to the signed-in member.
 * Email is stored only when zuey.me reports it verified; isAdmin derives from that email.
 */
import { newId, nowIso } from '../db/ids';
import { guestMergeStatements } from './guest-merge';
import { sessionDeleteByToken, sessionInsert } from './session-store';
import type { ZueyUserinfo } from './zuey-oauth-client';

export interface SignInInput {
  userinfo: ZueyUserinfo;
  /** Learner of the browser session that started (and finishes) the login. */
  current: { id: string; kind: 'guest' | 'member' } | null;
  /** Old cookie token, revoked as part of the rotation. */
  oldSessionToken: string | undefined;
  now: Date;
}

export interface SignInResult {
  memberId: string;
  sessionToken: string;
  /** 'promoted' guest became the member, 'merged' guest merged into an existing member, 'none' otherwise. */
  guestOutcome: 'promoted' | 'merged' | 'none';
  guestId: string | null;
  newMember: boolean;
}

export async function completeMemberSignIn(db: D1Database, input: SignInInput): Promise<SignInResult> {
  const { userinfo, current, now } = input;
  const ts = nowIso(now);
  const email = userinfo.emailVerified ? userinfo.email : null;
  const existing = await db.prepare('SELECT id, deleted_at FROM learners WHERE zuey_sub = ?')
    .bind(userinfo.sub).first<{ id: string; deleted_at: string | null }>();

  const stmts: D1PreparedStatement[] = [];
  let memberId: string;
  let guestOutcome: SignInResult['guestOutcome'] = 'none';
  const guestId = current?.kind === 'guest' ? current.id : null;

  if (existing && existing.deleted_at) {
    // A deleted account keeps no claim on the zuey identity: release it so a fresh member can be created.
    stmts.push(db.prepare('UPDATE learners SET zuey_sub = NULL, updated_at = ? WHERE id = ?').bind(ts, existing.id));
  }
  const live = existing && !existing.deleted_at ? existing : null;

  if (live) {
    memberId = live.id;
    stmts.push(db.prepare(
      `UPDATE learners SET email = ?, display_name = COALESCE(display_name, ?), avatar_url = ?, updated_at = ? WHERE id = ?`,
    ).bind(email, userinfo.name, userinfo.picture, ts, memberId));
    if (guestId && guestId !== memberId) {
      stmts.push(...guestMergeStatements(db, guestId, memberId, ts));
      guestOutcome = 'merged';
    }
  } else if (guestId) {
    memberId = guestId;
    stmts.push(db.prepare(
      `UPDATE learners SET kind = 'member', zuey_sub = ?, email = ?, display_name = COALESCE(display_name, ?), avatar_url = ?, updated_at = ?
        WHERE id = ? AND kind = 'guest'`,
    ).bind(userinfo.sub, email, userinfo.name, userinfo.picture, ts, memberId));
    guestOutcome = 'promoted';
  } else {
    memberId = newId('lrn');
    stmts.push(db.prepare(
      `INSERT INTO learners (id, kind, zuey_sub, email, display_name, avatar_url, profile_json, observer_consent, created_at, updated_at)
       VALUES (?, 'member', ?, ?, ?, ?, '{}', 0, ?, ?)`,
    ).bind(memberId, userinfo.sub, email, userinfo.name, userinfo.picture, ts, ts));
  }

  const revoke = await sessionDeleteByToken(db, input.oldSessionToken);
  if (revoke) stmts.push(revoke);
  const session = await sessionInsert(db, memberId, now);
  stmts.push(session.stmt);

  await db.batch(stmts);
  return { memberId, sessionToken: session.token, guestOutcome, guestId, newMember: !live };
}
