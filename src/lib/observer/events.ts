/**
 * Typed learning events (events table). Writers call recordEvent; the observer dashboard reads them only
 * for learners with observer consent. Props must never contain raw evidence text: evidence is read from
 * evidence_submissions under the consent gate.
 */
import { newId, nowIso } from '../db/ids';
import type { Source } from '../learning/types';

export type EventName =
  | 'onboarding.completed' | 'onboarding.skipped'
  | 'mission.started' | 'mission.step_viewed' | 'mission.step_completed' | 'mission.abandoned'
  | 'hint.requested' | 'coach.chat_sent'
  | 'evidence.submitted' | 'evaluation.completed' | 'evaluation.failed'
  | 'xp.granted' | 'badge.granted' | 'level.up'
  | 'lab.started' | 'lab.completed' | 'concept.viewed'
  | 'reflection.submitted' | 'certificate.issued'
  | 'auth.signed_in' | 'auth.guest_merged'
  | 'push.subscribed' | 'push.unsubscribed' | 'push.sent' | 'push.opened'
  | 'consent.granted' | 'consent.revoked'
  | 'ai.budget_exceeded' | 'ai.fallback_used';

export interface LearningEvent {
  learnerId: string;
  name: EventName;
  missionId?: string;
  missionVersion?: number;
  runId?: string;
  props?: Record<string, string | number | boolean | null>;
  source?: Source;
  occurredAt?: string;
}

export async function recordEvent(db: D1Database, e: LearningEvent): Promise<void> {
  await db.prepare(
    `INSERT INTO events (id, learner_id, name, schema_version, mission_id, mission_version, run_id, props_json, source, occurred_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId('evt'), e.learnerId, e.name, e.missionId ?? null, e.missionVersion ?? null, e.runId ?? null,
    JSON.stringify(e.props ?? {}), e.source ?? 'web', e.occurredAt ?? nowIso(),
  ).run();
}

/** Same as recordEvent but never throws: analytics must not break a learner action. */
export async function recordEventSafe(db: D1Database, e: LearningEvent): Promise<void> {
  try {
    await recordEvent(db, e);
  } catch (err) {
    console.error('recordEvent failed', e.name, err);
  }
}
