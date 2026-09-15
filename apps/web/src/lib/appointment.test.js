import { describe, it, expect } from 'vitest';
import {
  isStartableNow, startabilityLabel, isExpiredAppointment, appointmentStartStatus,
  groupSessionCards, nextStartBoundary,
} from './appointment.js';
import { startEligibility, zonedWallTimeToUtc, START_WINDOW_MS } from './businessDate.js';

/**
 * Client mirror of the ONE session start rule: each scheduled date opens a
 * 24-hour start window at the scheduled start (org-timezone midnight for a
 * date-only booking). TIMESTAMP-based — never "appointment date === today".
 * The server recomputes the same rule and remains the authority.
 */
const TZ = 'America/New_York';
const wall = (date, hh, mm = 0, ss = 0, tz = TZ) => {
  const [y, m, d] = date.split('-').map(Number);
  return zonedWallTimeToUtc(y, m, d, hh, mm, ss, tz);
};
/** A timed appointment at an org-local wall clock (1 hour long). */
const timed = (date, hh, mm = 0, tz = TZ) => {
  const s = wall(date, hh, mm, 0, tz);
  return { startAt: s.toISOString(), endAt: new Date(s.getTime() + 3.6e6).toISOString(), timeSet: true };
};
/** A date-only appointment, stored the way booking stores it: org midnight → next org midnight. */
const dateOnly = (first, last = first, tz = TZ) => {
  const [y, m, d] = last.split('-').map(Number);
  const after = new Date(Date.UTC(y, m - 1, d + 1));
  const end = zonedWallTimeToUtc(after.getUTCFullYear(), after.getUTCMonth() + 1, after.getUTCDate(), 0, 0, 0, tz);
  return { startAt: wall(first, 0, 0, 0, tz).toISOString(), endAt: end.toISOString(), timeSet: false };
};

describe('24-hour start window (timestamp-based)', () => {
  it('1. 09/12 10:00 AM → 09/13 9:00 AM is ALLOWED', () => {
    expect(isStartableNow(timed('2026-09-12', 10), TZ, wall('2026-09-13', 9))).toBe(true);
  });
  it('2. 09/12 10:00 AM → 09/13 10:00 AM is EXPIRED (09:59:59 still open)', () => {
    const a = timed('2026-09-12', 10);
    expect(isStartableNow(a, TZ, wall('2026-09-13', 9, 59, 59))).toBe(true);
    expect(appointmentStartStatus(a, TZ, wall('2026-09-13', 10))).toBe('EXPIRED');
  });
  it('3. 09/12 10:00 AM → 09/13 10:01 AM is EXPIRED', () => {
    expect(isExpiredAppointment(timed('2026-09-12', 10), TZ, wall('2026-09-13', 10, 1))).toBe(true);
  });
  it('4. 09/12 7:00 PM → 09/13 6:30 PM is ALLOWED', () => {
    expect(isStartableNow(timed('2026-09-12', 19), TZ, wall('2026-09-13', 18, 30))).toBe(true);
  });
  it('5. 09/12 7:00 PM → 09/13 7:01 PM is EXPIRED', () => {
    expect(isExpiredAppointment(timed('2026-09-12', 19), TZ, wall('2026-09-13', 19, 1))).toBe(true);
  });
  it('6. a future appointment is UPCOMING until its window opens', () => {
    const a = timed('2026-09-14', 10);
    expect(appointmentStartStatus(a, TZ, wall('2026-09-14', 9, 59))).toBe('UPCOMING');
    expect(isStartableNow(a, TZ, wall('2026-09-14', 10))).toBe(true);
  });
  it('the window is exactly 24 hours and matches the scheduled start', () => {
    const e = startEligibility(timed('2026-09-12', 10), TZ, wall('2026-09-12', 12));
    expect(e.windowEnd.getTime() - e.windowStart.getTime()).toBe(START_WINDOW_MS);
    expect(e.windowStart.toISOString()).toBe(wall('2026-09-12', 10).toISOString());
  });
  it('11. business timezone + DST: 24 REAL hours across the fall-back (10/31 7 PM EDT → 11/01 6 PM EST)', () => {
    const a = timed('2026-10-31', 19);
    expect(isStartableNow(a, TZ, wall('2026-11-01', 17, 59))).toBe(true);
    expect(isExpiredAppointment(a, TZ, wall('2026-11-01', 18))).toBe(true);
    for (const tz of ['America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
      expect(isStartableNow(timed('2026-09-12', 19, 0, tz), tz, wall('2026-09-13', 18, 30, 0, tz))).toBe(true);
      expect(isExpiredAppointment(timed('2026-09-12', 19, 0, tz), tz, wall('2026-09-13', 19, 1, 0, tz))).toBe(true);
    }
  });
  it('12. date-only (timeSet:false): 24 hours from org midnight of the business date', () => {
    const a = dateOnly('2026-09-12');
    expect(appointmentStartStatus(a, TZ, wall('2026-09-11', 23, 59))).toBe('UPCOMING');
    expect(isStartableNow(a, TZ, wall('2026-09-12', 0))).toBe(true);
    expect(isStartableNow(a, TZ, wall('2026-09-12', 23, 59, 59))).toBe(true);
    expect(isExpiredAppointment(a, TZ, wall('2026-09-13', 0))).toBe(true);
  });
  it('multi-day date-only: startable in any date window, expired after the last', () => {
    const a = dateOnly('2026-09-12', '2026-09-14');
    expect(isStartableNow(a, TZ, wall('2026-09-14', 23))).toBe(true);
    expect(isExpiredAppointment(a, TZ, wall('2026-09-15', 0))).toBe(true);
  });
  it('an undated appointment is not window-gated', () => {
    expect(isStartableNow({}, 'UTC', new Date())).toBe(true);
  });
  it("the server's EXPIRED verdict always stands", () => {
    expect(isExpiredAppointment({ ...timed('2026-09-12', 10), startStatus: 'EXPIRED' }, TZ, wall('2026-09-12', 11))).toBe(true);
  });
});

describe('startabilityLabel (MM/DD/YYYY, org timezone, never the error code)', () => {
  it('is null while the window is open', () => {
    expect(startabilityLabel(timed('2026-09-12', 10), TZ, wall('2026-09-13', 9))).toBe(null);
  });
  it('upcoming timed → "Available from …"; upcoming date-only → "Available on …"', () => {
    expect(startabilityLabel(timed('2026-09-14', 10), TZ, wall('2026-09-13', 12))).toBe('Available from 09/14/2026 10:00 AM');
    expect(startabilityLabel(dateOnly('2026-09-14'), TZ, wall('2026-09-13', 12))).toBe('Available on 09/14/2026');
  });
  it('expired → the exact time the 24-hour window closed', () => {
    const label = startabilityLabel(timed('2026-09-12', 10), TZ, wall('2026-09-13', 10, 1));
    expect(label).toBe('Expired — start window closed 09/13/2026 10:00 AM');
    expect(label).not.toMatch(/APPOINTMENT_NOT_TODAY|2026-09/);
  });
});

describe('grouping and the re-render boundary', () => {
  const cards = [
    { appointmentId: 'a12', ...timed('2026-09-12', 10), sessionStatus: 'SCHEDULED' },
    { appointmentId: 'a13', ...timed('2026-09-13', 10), sessionStatus: 'SCHEDULED' },
    { appointmentId: 'a14', ...timed('2026-09-14', 10), sessionStatus: 'SCHEDULED' },
  ];
  const ids = (g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((c) => c.appointmentId)]));

  it('7. groups by open window, not calendar date: only open windows are "current"', () => {
    expect(ids(groupSessionCards(cards, TZ, wall('2026-09-13', 9, 30)))).toEqual({ current: ['a12'], upcoming: ['a13', 'a14'], expired: [] });
    expect(ids(groupSessionCards(cards, TZ, wall('2026-09-13', 11)))).toEqual({ current: ['a13'], upcoming: ['a14'], expired: ['a12'] });
    expect(ids(groupSessionCards(cards, TZ, wall('2026-09-14', 10)))).toEqual({ current: ['a14'], upcoming: [], expired: ['a12', 'a13'] });
  });

  it('a live (running/stopped) session stays "current" after its window closes so it can be finished', () => {
    const live = [{ ...cards[0], sessionStatus: 'STOPPED' }];
    expect(ids(groupSessionCards(live, TZ, wall('2026-09-14', 12))).current).toEqual(['a12']);
  });

  it('the next boundary is the nearest window open/close instant', () => {
    expect(nextStartBoundary(cards, TZ, wall('2026-09-13', 9, 30)).toISOString()).toBe(wall('2026-09-13', 10).toISOString());
    expect(nextStartBoundary([cards[0]], TZ, wall('2026-09-14', 12))).toBe(null);
  });
});
