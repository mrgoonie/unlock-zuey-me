/**
 * Observer consent (learners.observer_consent). Granting lets admins see the learner's journey in /admin;
 * revoking hides it on the very next dashboard query (the gate lives in src/lib/observer/queries.ts).
 */
import { nowIso } from '../db/ids';
import { recordEventSafe } from '../observer/events';

/** Sets consent and records consent.granted/revoked when the value actually changes. Returns the new value. */
export async function setObserverConsent(db: D1Database, learnerId: string, observer: boolean): Promise<boolean> {
  const value = observer ? 1 : 0;
  const now = nowIso();
  const r = await db.prepare(
    `UPDATE learners SET observer_consent = ?, observer_consent_at = ?, updated_at = ?
     WHERE id = ? AND observer_consent <> ?`,
  ).bind(value, now, now, learnerId, value).run();
  if (r.meta.changes) {
    await recordEventSafe(db, { learnerId, name: observer ? 'consent.granted' : 'consent.revoked', occurredAt: now });
  }
  return observer;
}
