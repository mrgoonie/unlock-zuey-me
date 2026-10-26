import { describe, expect, it } from 'vitest';
import { buildReminderCopy } from '../../src/lib/push/reminder-copy';
import { isReminderDue, isValidRemindTime, isValidTimezone, localClock, quarterWindow } from '../../src/lib/push/reminder-window';

describe('reminder due window', () => {
  it('computes the quarter-hour window, including the last one of the day', () => {
    expect(quarterWindow(20 * 60 + 7)).toEqual({ start: '20:00', end: '20:15' });
    expect(quarterWindow(0)).toEqual({ start: '00:00', end: '00:15' });
    expect(quarterWindow(23 * 60 + 59)).toEqual({ start: '23:45', end: '24:00' });
  });

  it('is due only inside the same local quarter hour (Asia/Saigon, UTC+7, no DST)', () => {
    const now = new Date('2026-10-26T13:00:00Z'); // 20:00 in Saigon
    expect(isReminderDue(now, 'Asia/Saigon', '20:00', null)).toBe(true);
    expect(isReminderDue(now, 'Asia/Saigon', '20:14', null)).toBe(true);
    expect(isReminderDue(now, 'Asia/Saigon', '20:15', null)).toBe(false);
    expect(isReminderDue(now, 'Asia/Saigon', '19:59', null)).toBe(false);
    expect(isReminderDue(now, 'UTC', '20:00', null)).toBe(false);
  });

  it('handles half-hour and 45-minute offsets', () => {
    expect(isReminderDue(new Date('2026-10-26T14:30:00Z'), 'Asia/Kolkata', '20:00', null)).toBe(true);
    expect(isReminderDue(new Date('2026-10-26T14:15:00Z'), 'Asia/Kathmandu', '20:00', null)).toBe(true);
    expect(isReminderDue(new Date('2026-10-26T14:00:00Z'), 'Asia/Kathmandu', '20:00', null)).toBe(false);
  });

  it('follows DST: 20:00 New York is 00:00Z in summer and 01:00Z in winter', () => {
    expect(isReminderDue(new Date('2026-07-02T00:00:00Z'), 'America/New_York', '20:00', null)).toBe(true);
    expect(isReminderDue(new Date('2026-12-02T00:00:00Z'), 'America/New_York', '20:00', null)).toBe(false);
    expect(isReminderDue(new Date('2026-12-02T01:00:00Z'), 'America/New_York', '20:00', null)).toBe(true);
  });

  it('uses the local calendar day, not the UTC day, for once-per-day idempotency', () => {
    const now = new Date('2026-10-26T17:30:00Z'); // 00:30 on 27 Oct in Saigon
    expect(localClock(now, 'Asia/Saigon')).toEqual({ day: '2026-10-27', minutes: 30 });
    expect(isReminderDue(now, 'Asia/Saigon', '00:30', '2026-10-26')).toBe(true);
    expect(isReminderDue(now, 'Asia/Saigon', '00:30', '2026-10-27')).toBe(false);
  });

  it('validates inputs', () => {
    expect(isValidTimezone('Asia/Saigon')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidRemindTime('07:05')).toBe(true);
    for (const bad of ['7:05', '24:00', '12:60', '12:5', 'abc']) expect(isValidRemindTime(bad)).toBe(false);
    expect(isReminderDue(new Date(), 'Asia/Saigon', 'nope', null)).toBe(false);
  });
});

describe('reminder copy', () => {
  it('links to the in-progress mission and mentions its title', () => {
    const c = buildReminderCopy('seed', { id: 'plan-weekend', title: 'Lên kế hoạch cuối tuần cùng AI' });
    expect(c.path).toBe('/missions/plan-weekend');
    expect(c.body).toContain('Lên kế hoạch cuối tuần cùng AI');
  });

  it('falls back to /home and varies copy across seeds', () => {
    const variants = new Set(Array.from({ length: 30 }, (_, i) => buildReminderCopy(`s${i}`).title));
    expect(variants.size).toBeGreaterThan(1);
    expect(buildReminderCopy('x').path).toBe('/home');
    expect(buildReminderCopy('x')).toEqual(buildReminderCopy('x'));
  });
});
