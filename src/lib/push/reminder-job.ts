/**
 * Cron job (every 15 min): sends the daily reminder to subscriptions whose remind_time falls in the
 * current local quarter hour (or up to LOOKBACK_MINUTES earlier that day, so a run that ran out of time or
 * a skipped cron tick is caught up), at most once per local day, skipping learners already active today.
 * Due subscriptions are processed in batches until none are left or the run's time budget is spent.
 *
 * Idempotency: a subscription is "claimed" by setting last_sent_day with a conditional UPDATE before the
 * push is sent, so overlapping or retried cron runs never send twice on the same day, and a claimed row
 * never comes back in a later batch.
 */
import type { VapidKeys } from '@block65/webcrypto-web-push';
import { getMission } from '../content/loader';
import { recordEventSafe } from '../observer/events';
import { buildReminderCopy } from './reminder-copy';
import { localClock, quarterWindow, WINDOW_MINUTES } from './reminder-window';
import { sendWebPush, vapidFromEnv, type FetchLike } from './web-push-sender';

/** Due subscriptions read per query. */
export const BATCH_SIZE = 100;
/** Pushes in flight at once (Workers allow six simultaneous outbound connections). */
export const SEND_CONCURRENCY = 6;
/**
 * Pushes per run. Each costs ~5 subrequests (D1 + push service) and the cron shares one invocation's
 * 10k-subrequest and 30 s CPU limits with the other jobs; the look-back hands the rest to the next run.
 */
export const MAX_SENDS_PER_RUN = 1000;
/** Wall-clock budget of one run; whatever is left is picked up by the next run through the look-back. */
export const TIME_BUDGET_MS = 5 * 60_000;
/** How far before the current quarter hour a not-yet-sent reminder is still delivered (same local day). */
export const LOOKBACK_MINUTES = 60;
/** Consecutive failures after which a subscription is disabled. */
export const MAX_FAILURES = 5;
const OPEN_RUN_STATUSES = `'started','paused','awaiting_evidence','needs_revision','evaluation_failed'`;

export interface ReminderJobDeps {
  now?: Date;
  fetchFn?: FetchLike;
  /** Resolves a mission id to its title (defaults to the bundled content). */
  missionTitle?: (missionId: string) => string | undefined;
  batchSize?: number;
  timeBudgetMs?: number;
  maxSends?: number;
  /** Milliseconds clock for the time budget (defaults to Date.now). */
  clock?: () => number;
}

type Outcome = 'sent' | 'removed' | 'failed' | 'skipped';

export interface ReminderJobResult extends Record<Outcome, number> {
  /** True when the time or send budget ran out before every due subscription was handled. */
  deferred: boolean;
}

interface DueRow { id: string; learner_id: string; endpoint: string; p256dh: string; auth: string }

const defaultMissionTitle = (id: string) => getMission(id)?.title;

/** The [start, end) HH:MM range of remind times due now in a zone: this quarter hour plus the look-back. */
function dueRange(minutes: number): { start: string; end: string } {
  const quarterStart = Math.floor(minutes / WINDOW_MINUTES) * WINDOW_MINUTES;
  return { start: quarterWindow(Math.max(0, quarterStart - LOOKBACK_MINUTES)).start, end: quarterWindow(minutes).end };
}

export async function sendDueReminders(
  env: Pick<Env, 'DB' | 'PUBLIC_SITE_URL' | 'VAPID_SUBJECT' | 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY'>,
  deps: ReminderJobDeps = {},
): Promise<ReminderJobResult> {
  const result: ReminderJobResult = { sent: 0, removed: 0, failed: 0, skipped: 0, deferred: false };
  const vapid = vapidFromEnv(env);
  if (!vapid) {
    console.warn('push reminders skipped: VAPID keys are not configured');
    return result;
  }
  const db = env.DB;
  const now = deps.now ?? new Date();
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + (deps.timeBudgetMs ?? TIME_BUDGET_MS);
  const batchSize = Math.max(1, deps.batchSize ?? BATCH_SIZE);
  let sendsLeft = deps.maxSends ?? MAX_SENDS_PER_RUN;

  const zones = await db.prepare('SELECT DISTINCT timezone FROM push_subscriptions WHERE enabled = 1').all<{ timezone: string }>();
  for (const { timezone } of zones.results) {
    let local;
    try {
      local = localClock(now, timezone);
    } catch {
      console.error('push reminders: invalid timezone in push_subscriptions', timezone);
      continue;
    }
    const { start, end } = dueRange(local.minutes);

    let more = true;
    while (more) {
      if (clock() >= deadline || sendsLeft <= 0) {
        result.deferred = true;
        console.warn('push reminders: run budget spent, the rest is caught up next run', result);
        return result;
      }
      const take = Math.min(batchSize, sendsLeft);
      // Claimed rows get last_sent_day = today, so each batch only sees subscriptions not handled yet.
      const due = await db.prepare(
        `SELECT s.id, s.learner_id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
         WHERE s.enabled = 1 AND s.timezone = ? AND s.remind_time >= ? AND s.remind_time < ?
           AND (s.last_sent_day IS NULL OR s.last_sent_day <> ?)
           AND NOT EXISTS (SELECT 1 FROM activity_days a WHERE a.learner_id = s.learner_id AND a.day = ?)
         ORDER BY s.remind_time, s.id LIMIT ?`,
      ).bind(timezone, start, end, local.day, local.day, take).all<DueRow>();
      sendsLeft -= due.results.length;

      for (let i = 0; i < due.results.length; i += SEND_CONCURRENCY) {
        const chunk = due.results.slice(i, i + SEND_CONCURRENCY);
        const outcomes = await Promise.all(chunk.map((row) => deliver(db, row, local.day, vapid, env.PUBLIC_SITE_URL, deps)));
        for (const o of outcomes) result[o]++;
      }
      more = due.results.length === take;
    }
  }
  return result;
}

async function deliver(
  db: D1Database, row: DueRow, day: string, vapid: VapidKeys, siteUrl: string, deps: ReminderJobDeps,
): Promise<Outcome> {
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
