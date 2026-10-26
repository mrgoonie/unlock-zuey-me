/**
 * Cron job (every 15 min): sends the daily reminder to subscriptions whose remind_time falls in the
 * current local quarter hour (or up to LOOKBACK_MINUTES earlier that day, so a run that ran out of budget or
 * a skipped cron tick is caught up), at most once per local day, skipping learners already active today.
 * Due subscriptions are processed in batches until none are left or the run's budget is spent.
 *
 * Idempotency: a chunk of subscriptions is "claimed" by setting last_sent_day with one conditional UPDATE
 * before its pushes are sent, so overlapping or retried cron runs never send twice on the same day, and a
 * claimed row never comes back in a later batch. Rows read but not claimed (budget ran out) stay due.
 *
 * D1 cost: one query per due batch (it also reads each learner's open mission), then per chunk of
 * SEND_CONCURRENCY pushes one claim UPDATE and one db.batch holding every result write and event, i.e.
 * about one D1 query per three sends. Each push is one fetch, charged to the subrequest budget
 * (src/lib/jobs/cron-budget.ts explains both limits).
 */
import type { VapidKeys } from '@block65/webcrypto-web-push';
import { getMission } from '../content/loader';
import { newId, nowIso } from '../db/ids';
import { createCronBudget, type CronBudget, type CronCost } from '../jobs/cron-budget';
import { buildReminderCopy } from './reminder-copy';
import { localClock, quarterWindow, WINDOW_MINUTES } from './reminder-window';
import { sendWebPush, vapidFromEnv, type FetchLike } from './web-push-sender';

/** Due subscriptions read per query. */
export const BATCH_SIZE = 100;
/** Pushes in flight at once (Workers allow six simultaneous outbound connections). */
export const SEND_CONCURRENCY = 6;
/** Pushes per run; the look-back hands the rest to the next run. */
export const MAX_SENDS_PER_RUN = 1000;
/** Wall-clock budget of one run; whatever is left is picked up by the next run through the look-back. */
export const TIME_BUDGET_MS = 5 * 60_000;
/** How far before the current quarter hour a not-yet-sent reminder is still delivered (same local day). */
export const LOOKBACK_MINUTES = 60;
/** Consecutive failures after which a subscription is disabled. */
export const MAX_FAILURES = 5;
const OPEN_RUN_STATUSES = `'started','paused','awaiting_evidence','needs_revision','evaluation_failed'`;

/** Budget cost of one chunk of `rows` pushes: the claim UPDATE and the result batch, plus one fetch per push. */
export const chunkCost = (rows: number): Required<CronCost> => ({ d1: 2, net: rows });

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
  /** Shared cron budget charged for every D1 query and push (defaults to a fresh full budget). */
  budget?: CronBudget;
}

type Outcome = 'sent' | 'removed' | 'failed' | 'skipped';

export interface ReminderJobResult extends Record<Outcome, number> {
  /** True when the time, send or request budget ran out before every due subscription was handled. */
  deferred: boolean;
}

interface DueRow {
  id: string;
  learner_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Mission of the learner's most recently touched open run, if any. */
  open_mission_id: string | null;
}

interface SendResult { status: number; variant: number; tag: string }

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
  const budget = deps.budget ?? createCronBudget({ clock });
  const batchSize = Math.max(1, deps.batchSize ?? BATCH_SIZE);
  let sendsLeft = deps.maxSends ?? MAX_SENDS_PER_RUN;
  const defer = () => {
    result.deferred = true;
    console.warn('push reminders: run budget spent, the rest is caught up next run', result);
    return result;
  };
  const oneChunk = chunkCost(1);

  // The zone list, one due batch and a chunk of one push must fit, or nothing is started.
  if (!budget.canAfford({ d1: 2 + oneChunk.d1, net: oneChunk.net })) return defer();
  budget.charge({ d1: 1 });
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
      if (clock() >= deadline || sendsLeft <= 0 || !budget.canAfford({ d1: 1 + oneChunk.d1, net: oneChunk.net })) return defer();
      const take = Math.min(batchSize, sendsLeft);
      budget.charge({ d1: 1 });
      // Claimed rows get last_sent_day = today, so each batch only sees subscriptions not handled yet.
      const due = await db.prepare(
        `SELECT s.id, s.learner_id, s.endpoint, s.p256dh, s.auth,
           (SELECT r.mission_id FROM mission_runs r WHERE r.learner_id = s.learner_id AND r.status IN (${OPEN_RUN_STATUSES})
            ORDER BY r.updated_at DESC LIMIT 1) AS open_mission_id
         FROM push_subscriptions s
         WHERE s.enabled = 1 AND s.timezone = ? AND s.remind_time >= ? AND s.remind_time < ?
           AND (s.last_sent_day IS NULL OR s.last_sent_day <> ?)
           AND NOT EXISTS (SELECT 1 FROM activity_days a WHERE a.learner_id = s.learner_id AND a.day = ?)
         ORDER BY s.remind_time, s.id LIMIT ?`,
      ).bind(timezone, start, end, local.day, local.day, take).all<DueRow>();

      for (let i = 0; i < due.results.length; i += SEND_CONCURRENCY) {
        const chunk = due.results.slice(i, i + SEND_CONCURRENCY);
        // Rows not claimed yet stay due; the next run picks them up through the look-back.
        if (clock() >= deadline || !budget.canAfford(chunkCost(chunk.length))) return defer();
        sendsLeft -= chunk.length;
        const outcomes = await deliverChunk(db, chunk, local.day, vapid, env.PUBLIC_SITE_URL, deps, budget);
        for (const o of outcomes) result[o]++;
      }
      more = due.results.length === take;
    }
  }
  return result;
}

/** Claims, sends and records one chunk of due subscriptions; returns one outcome per row. */
async function deliverChunk(
  db: D1Database, rows: DueRow[], day: string, vapid: VapidKeys, siteUrl: string, deps: ReminderJobDeps, budget: CronBudget,
): Promise<Outcome[]> {
  budget.charge({ d1: 1 });
  const claimed = await db.prepare(
    `UPDATE push_subscriptions SET last_sent_day = ?
     WHERE id IN (${rows.map(() => '?').join(', ')}) AND enabled = 1 AND (last_sent_day IS NULL OR last_sent_day <> ?)
     RETURNING id`,
  ).bind(day, ...rows.map((r) => r.id), day).all<{ id: string }>();
  const claimedIds = new Set(claimed.results.map((r) => r.id));
  const mine = rows.filter((r) => claimedIds.has(r.id));
  if (mine.length === 0) return rows.map(() => 'skipped');

  budget.charge({ net: mine.length });
  const sends = await Promise.all(mine.map((row) => sendOne(row, day, vapid, siteUrl, deps)));

  const occurredAt = nowIso();
  // Same row shape as recordEvent (src/lib/observer/events.ts), written in the chunk's batch to save queries.
  const event = (learnerId: string, name: string, missionId: string | null, props: Record<string, string | number>) => db.prepare(
    `INSERT INTO events (id, learner_id, name, schema_version, mission_id, mission_version, run_id, props_json, source, occurred_at)
     VALUES (?, ?, ?, 1, ?, NULL, NULL, ?, 'web', ?)`,
  ).bind(newId('evt'), learnerId, name, missionId, JSON.stringify(props), occurredAt);

  const writes: D1PreparedStatement[] = [];
  const events: D1PreparedStatement[] = [];
  const outcomes = new Map<string, Outcome>();
  mine.forEach((row, i) => {
    const { status, variant, tag } = sends[i];
    if (status >= 200 && status < 300) {
      writes.push(db.prepare('UPDATE push_subscriptions SET failures = 0 WHERE id = ?').bind(row.id));
      events.push(event(row.learner_id, 'push.sent', row.open_mission_id, { variant, tag, day }));
      outcomes.set(row.id, 'sent');
    } else if (status === 404 || status === 410) {
      writes.push(db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(row.id));
      events.push(event(row.learner_id, 'push.unsubscribed', null, { reason: 'expired', status }));
      outcomes.set(row.id, 'removed');
    } else {
      writes.push(db.prepare(
        `UPDATE push_subscriptions SET failures = failures + 1,
           enabled = CASE WHEN failures + 1 >= ? THEN 0 ELSE enabled END
         WHERE id = ?`,
      ).bind(MAX_FAILURES, row.id));
      outcomes.set(row.id, 'failed');
    }
  });

  budget.charge({ d1: 1 });
  try {
    await db.batch([...writes, ...events]);
  } catch (err) {
    // Analytics must not cost the subscription state: retry the state writes alone (budget headroom covers it).
    console.error('push reminders: result batch failed, retrying without events', err);
    budget.charge({ d1: 1 });
    try {
      await db.batch(writes);
    } catch (retryErr) {
      // The pushes already went out and the rows stay claimed for today (no double send), so the run goes on
      // with the other chunks; only this chunk's failure counters and cleanup are lost until the next send.
      console.error('push reminders: state writes failed after sending, continuing', retryErr);
    }
  }
  return rows.map((r) => outcomes.get(r.id) ?? 'skipped');
}

/** Builds the copy for one claimed row and sends it; a network error counts as status 0 (a failure). */
async function sendOne(row: DueRow, day: string, vapid: VapidKeys, siteUrl: string, deps: ReminderJobDeps): Promise<SendResult> {
  const missionId = row.open_mission_id;
  const title = missionId ? (deps.missionTitle ?? defaultMissionTitle)(missionId) : undefined;
  const copy = buildReminderCopy(`${row.id}:${day}`, missionId && title ? { id: missionId, title } : null);
  let status = 0;
  try {
    status = await sendWebPush(row, { ...copy, url: new URL(copy.path, siteUrl).toString() }, vapid, deps.fetchFn);
  } catch (err) {
    console.error('push send failed', row.id, err);
  }
  return { status, variant: copy.variant, tag: copy.tag };
}
