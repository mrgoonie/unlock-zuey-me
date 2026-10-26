/**
 * Cron job (every 15 min): sends the daily reminder to subscriptions whose remind_time falls in the
 * current local quarter hour, at most once per local day, skipping learners already active today.
 *
 * Idempotency: a subscription is "claimed" by setting last_sent_day with a conditional UPDATE before the
 * push is sent, so overlapping or retried cron runs never send twice on the same day.
 */
import type { VapidKeys } from '@block65/webcrypto-web-push';
import { getMission } from '../content/loader';
import { recordEventSafe } from '../observer/events';
import { buildReminderCopy } from './reminder-copy';
import { localClock, quarterWindow } from './reminder-window';
import { sendWebPush, vapidFromEnv, type FetchLike } from './web-push-sender';

/** Upper bound of pushes per cron run (keeps one run well inside the Worker time budget). */
export const MAX_SENDS_PER_RUN = 100;
/** Consecutive failures after which a subscription is disabled. */
export const MAX_FAILURES = 5;
const OPEN_RUN_STATUSES = `'started','paused','awaiting_evidence','needs_revision','evaluation_failed'`;

export interface ReminderJobDeps {
  now?: Date;
  fetchFn?: FetchLike;
  /** Resolves a mission id to its title (defaults to the bundled content). */
  missionTitle?: (missionId: string) => string | undefined;
  limit?: number;
}

export interface ReminderJobResult {
  sent: number;
  removed: number;
  failed: number;
  skipped: number;
}

interface DueRow { id: string; learner_id: string; endpoint: string; p256dh: string; auth: string }

const defaultMissionTitle = (id: string) => getMission(id)?.title;

export async function sendDueReminders(
  env: Pick<Env, 'DB' | 'PUBLIC_SITE_URL' | 'VAPID_SUBJECT' | 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY'>,
  deps: ReminderJobDeps = {},
): Promise<ReminderJobResult> {
  const result: ReminderJobResult = { sent: 0, removed: 0, failed: 0, skipped: 0 };
  const vapid = vapidFromEnv(env);
  if (!vapid) {
    console.warn('push reminders skipped: VAPID keys are not configured');
    return result;
  }
  const db = env.DB;
  const now = deps.now ?? new Date();
  let budget = deps.limit ?? MAX_SENDS_PER_RUN;

  const zones = await db.prepare('SELECT DISTINCT timezone FROM push_subscriptions WHERE enabled = 1').all<{ timezone: string }>();
  for (const { timezone } of zones.results) {
    if (budget <= 0) break;
    let clock;
    try {
      clock = localClock(now, timezone);
    } catch {
      console.error('push reminders: invalid timezone in push_subscriptions', timezone);
      continue;
    }
    const { start, end } = quarterWindow(clock.minutes);
    const due = await db.prepare(
      `SELECT s.id, s.learner_id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
       WHERE s.enabled = 1 AND s.timezone = ? AND s.remind_time >= ? AND s.remind_time < ?
         AND (s.last_sent_day IS NULL OR s.last_sent_day <> ?)
         AND NOT EXISTS (SELECT 1 FROM activity_days a WHERE a.learner_id = s.learner_id AND a.day = ?)
       ORDER BY s.id LIMIT ?`,
    ).bind(timezone, start, end, clock.day, clock.day, budget).all<DueRow>();

    for (const row of due.results) {
      budget--;
      const outcome = await deliver(db, row, clock.day, vapid, env.PUBLIC_SITE_URL, deps);
      result[outcome]++;
    }
  }
  return result;
}

async function deliver(
  db: D1Database, row: DueRow, day: string, vapid: VapidKeys, siteUrl: string, deps: ReminderJobDeps,
): Promise<keyof ReminderJobResult> {
  const claim = await db.prepare(
    `UPDATE push_subscriptions SET last_sent_day = ?
     WHERE id = ? AND enabled = 1 AND (last_sent_day IS NULL OR last_sent_day <> ?)`,
  ).bind(day, row.id, day).run();
  if (!claim.meta.changes) return 'skipped';

  const open = await db.prepare(
    `SELECT mission_id FROM mission_runs WHERE learner_id = ? AND status IN (${OPEN_RUN_STATUSES})
     ORDER BY updated_at DESC LIMIT 1`,
  ).bind(row.learner_id).first<{ mission_id: string }>();
  const title = open ? (deps.missionTitle ?? defaultMissionTitle)(open.mission_id) : undefined;
  const copy = buildReminderCopy(`${row.id}:${day}`, open && title ? { id: open.mission_id, title } : null);

  let status = 0;
  try {
    status = await sendWebPush(row, { ...copy, url: new URL(copy.path, siteUrl).toString() }, vapid, deps.fetchFn);
  } catch (err) {
    console.error('push send failed', row.id, err);
  }

  if (status >= 200 && status < 300) {
    await db.prepare('UPDATE push_subscriptions SET failures = 0 WHERE id = ?').bind(row.id).run();
    await recordEventSafe(db, {
      learnerId: row.learner_id, name: 'push.sent', missionId: open?.mission_id,
      props: { variant: copy.variant, tag: copy.tag, day },
    });
    return 'sent';
  }
  if (status === 404 || status === 410) {
    await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.id).run();
    await recordEventSafe(db, { learnerId: row.learner_id, name: 'push.unsubscribed', props: { reason: 'expired', status } });
    return 'removed';
  }
  await db.prepare(
    `UPDATE push_subscriptions SET failures = failures + 1,
       enabled = CASE WHEN failures + 1 >= ? THEN 0 ELSE enabled END
     WHERE id = ?`,
  ).bind(MAX_FAILURES, row.id).run();
  return 'failed';
}
