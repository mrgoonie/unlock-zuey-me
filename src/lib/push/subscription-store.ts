/**
 * push_subscriptions persistence and request validation for /api/v1/push/*. Every write is scoped to the
 * calling learner; an endpoint re-subscribed from a device moves to whoever is using it now.
 */
import { z } from 'zod';
import { newId, nowIso } from '../db/ids';
import { DEFAULT_TIMEZONE, isValidRemindTime, isValidTimezone } from './reminder-window';

/**
 * Push services we deliver to. Restricting hosts keeps the cron from being used to POST to arbitrary URLs.
 * Covers Chrome/Edge/Android (FCM), Firefox (Mozilla autopush), Safari/iOS (Apple) and legacy Edge (WNS).
 */
const PUSH_HOST_SUFFIXES = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return PUSH_HOST_SUFFIXES.some((s) => url.hostname === s || url.hostname.endsWith(`.${s}`));
}

const remindTime = z.string().refine(isValidRemindTime, 'remindTime phải có dạng HH:MM');
const timezone = z.string().refine(isValidTimezone, 'timezone không hợp lệ');
/** base64url key material from PushSubscription.toJSON(). */
const b64url = (max: number) => z.string().min(8).max(max).regex(/^[A-Za-z0-9_-]+=*$/, 'base64url');

export const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().max(1024).refine(isAllowedPushEndpoint, 'endpoint không phải dịch vụ push được hỗ trợ'),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: b64url(200), auth: b64url(64) }),
  }),
  remindTime: remindTime.default('20:00'),
  timezone: timezone.default(DEFAULT_TIMEZONE),
});
export type SubscribeInput = z.infer<typeof subscribeSchema>;

export const unsubscribeSchema = z.object({ endpoint: z.string().min(1).max(1024) });

export const settingsSchema = z.object({ remindTime: remindTime.optional(), enabled: z.boolean().optional() })
  .refine((v) => v.remindTime !== undefined || v.enabled !== undefined, 'Cần remindTime hoặc enabled');
export type SettingsInput = z.infer<typeof settingsSchema>;

export interface PushStatus {
  /** Number of devices subscribed for this learner. */
  devices: number;
  enabled: boolean;
  remindTime: string;
  timezone: string;
  lastSentDay: string | null;
}

export async function upsertSubscription(db: D1Database, learnerId: string, input: SubscribeInput): Promise<void> {
  const { endpoint, keys } = input.subscription;
  await db.prepare(
    `INSERT INTO push_subscriptions (id, learner_id, endpoint, p256dh, auth, remind_time, timezone, enabled, failures, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
     ON CONFLICT(endpoint) DO UPDATE SET learner_id = excluded.learner_id, p256dh = excluded.p256dh, auth = excluded.auth,
       remind_time = excluded.remind_time, timezone = excluded.timezone, enabled = 1, failures = 0`,
  ).bind(newId('psh'), learnerId, endpoint, keys.p256dh, keys.auth, input.remindTime, input.timezone, nowIso()).run();
  // One reminder time per learner: keep the learner's other devices in step.
  await db.prepare('UPDATE push_subscriptions SET remind_time = ?, timezone = ? WHERE learner_id = ?')
    .bind(input.remindTime, input.timezone, learnerId).run();
}

/** Removes the endpoint if it belongs to the learner. Returns whether a row was deleted (idempotent). */
export async function removeSubscription(db: D1Database, learnerId: string, endpoint: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM push_subscriptions WHERE learner_id = ? AND endpoint = ?').bind(learnerId, endpoint).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Applies settings to all of the learner's devices. Returns the number of subscriptions updated. */
export async function updateSettings(db: D1Database, learnerId: string, input: SettingsInput): Promise<number> {
  const r = await db.prepare(
    `UPDATE push_subscriptions SET remind_time = COALESCE(?, remind_time),
       enabled = COALESCE(?, enabled), failures = CASE WHEN ? = 1 THEN 0 ELSE failures END
     WHERE learner_id = ?`,
  ).bind(input.remindTime ?? null, input.enabled === undefined ? null : Number(input.enabled), input.enabled ? 1 : 0, learnerId).run();
  return r.meta.changes ?? 0;
}

export async function getPushStatus(db: D1Database, learnerId: string): Promise<PushStatus> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS devices, MAX(enabled) AS enabled, MAX(remind_time) AS remind_time, MAX(timezone) AS timezone,
            MAX(last_sent_day) AS last_sent_day
     FROM push_subscriptions WHERE learner_id = ?`,
  ).bind(learnerId).first<{ devices: number; enabled: number | null; remind_time: string | null; timezone: string | null; last_sent_day: string | null }>();
  return {
    devices: Number(row?.devices ?? 0),
    enabled: Number(row?.enabled ?? 0) === 1,
    remindTime: row?.remind_time ?? '20:00',
    timezone: row?.timezone ?? DEFAULT_TIMEZONE,
    lastSentDay: row?.last_sent_day ?? null,
  };
}
