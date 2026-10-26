/**
 * Time math for daily reminders. The cron fires every 15 minutes (UTC); a subscription is due when its
 * remind_time (HH:MM, learner local) falls in the same quarter hour as the learner's local "now".
 * All zone handling goes through Intl, so half-hour/45-minute offsets and DST zones work without tables.
 */

export const DEFAULT_TIMEZONE = 'Asia/Saigon';
export const WINDOW_MINUTES = 15;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** True when the runtime knows the IANA zone (rejects junk before it reaches the database). */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const isValidRemindTime = (value: string): boolean => HHMM.test(value);

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalClock {
  /** YYYY-MM-DD in the zone (matches activity_days.day and push_subscriptions.last_sent_day). */
  day: string;
  /** Minutes since local midnight, 0..1439. */
  minutes: number;
}

/** Local calendar day and clock time of `now` in `tz`. Throws RangeError for an unknown zone. */
export function localClock(now: Date, tz: string): LocalClock {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(now)) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: hour * 60 + Number(parts.minute) };
}

const pad = (n: number) => String(n).padStart(2, '0');
const toHhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/**
 * The quarter hour containing `minutes` as a half-open HH:MM range [start, end). `end` may be "24:00",
 * which still compares correctly as a string against zero-padded remind_time values.
 */
export function quarterWindow(minutes: number): { start: string; end: string } {
  const start = Math.floor(minutes / WINDOW_MINUTES) * WINDOW_MINUTES;
  return { start: toHhmm(start), end: toHhmm(start + WINDOW_MINUTES) };
}

/** Whether a reminder at `remindTime` is due at `now` in `tz` and was not already sent that local day. */
export function isReminderDue(now: Date, tz: string, remindTime: string, lastSentDay: string | null): boolean {
  if (!isValidRemindTime(remindTime)) return false;
  const clock = localClock(now, tz);
  const { start, end } = quarterWindow(clock.minutes);
  return remindTime >= start && remindTime < end && lastSentDay !== clock.day;
}
