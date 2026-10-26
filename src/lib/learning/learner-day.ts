/** Calendar-day helpers in the learner's timezone (profile.timezone, default Asia/Saigon). Days are YYYY-MM-DD. */
export const DEFAULT_TIMEZONE = 'Asia/Saigon';

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const resolveTimezone = (tz: string | undefined | null): string =>
  tz && isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;

/** The calendar day of `date` in `timezone`. */
export function localDay(date: Date, timezone?: string | null): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

const toUtcMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export function addDays(day: string, n: number): string {
  return new Date(toUtcMs(day) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `b` to `a` (a − b). */
export const dayDiff = (a: string, b: string): number => Math.round((toUtcMs(a) - toUtcMs(b)) / 86_400_000);

/** UTC day used for AI budgets (budgets reset at 00:00 UTC). */
export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);
