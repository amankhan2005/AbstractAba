/**
 * ---------------------------------------------------------------------------
 * WEEKLY HOURS — pure window + summary math (spec §K, §L, §M, §N).
 *
 * The BCBA dashboard shows progress toward the COMPANY-configured weekly work
 * requirement, computed from ACTUAL valid worked session time. This module owns
 * only the arithmetic and the calendar-week boundary; it never reads a database
 * and never fabricates time. The service supplies the summed worked minutes (the
 * authoritative SessionTimeRecord.workedMinutes) and the configured target; here
 * we only:
 *
 *   - resolve the CURRENT company week [start, end) in the company's OWN
 *     timezone with the company's OWN week-start day (§L: "Use the company's
 *     configured week/timezone"; NOT a rolling seven-day window);
 *   - turn a target + a completed total into a progress summary (§K, §L).
 *
 * Worked minutes come straight from the recorded per-session worked time, so a
 * BCBA who works one hour advances by exactly one hour (§M/§N: appointment
 * duration is the ceiling, never the amount; unused time is never counted).
 * ---------------------------------------------------------------------------
 */

/**
 * The zone math this module needs now lives in the ONE business-date authority
 * (domain/businessDate.js), because Scheduling needs exactly the same arithmetic
 * and the platform must not hold two implementations of "what day is it for
 * this company". These re-exports keep every existing caller of
 * `weeklyHours.zonedMidnightToUtc` (payroll.periods, bcbaSession.service)
 * working unchanged — this is a move, not a second copy.
 */
import { zonedParts, zonedMidnightToUtc } from '../../domain/businessDate.js';

export { zonedMidnightToUtc };

/**
 * The clinician hours week is STRICTLY Monday → Sunday (1 = Monday), in the
 * organization timezone. "My Hours" and the weekly-hours block both use it, so
 * on Monday 00:00 org time the current week rolls over and its total starts
 * again from the persisted records — nothing is reset or deleted; the previous
 * week simply falls outside the window. It is deliberately NOT the company
 * `staffing.weekStartsOn` setting (default Sunday), which would make 09/13
 * (a Sunday) the first day of a new week instead of the last day of this one.
 * Payroll periods are resolved separately (payroll.periods.js).
 */
export const HOURS_WEEK_STARTS_ON = 1;

/**
 * The current company week as a half-open UTC interval [start, end).
 *
 * @param {Date}   now           the instant to locate (server clock)
 * @param {string} timeZone      IANA zone, e.g. 'America/New_York' (org.timezone)
 * @param {number} weekStartsOn  0 = Sunday … 6 = Saturday (company setting)
 * @returns {{ start: Date, end: Date, weekStartsOn: number, timeZone: string }}
 */
export function companyWeekWindow(now, timeZone, weekStartsOn = 0) {
  const zone = timeZone || 'UTC';
  const wsd = ((Number(weekStartsOn) % 7) + 7) % 7;
  const local = zonedParts(now, zone);
  const backDays = ((local.weekday - wsd) + 7) % 7;

  // Local calendar date of the week's first day (subtract whole days on the
  // civil calendar, letting Date.UTC normalise month/year rollover).
  const startCivil = new Date(Date.UTC(local.year, local.month - 1, local.day - backDays));
  const start = zonedMidnightToUtc(
    startCivil.getUTCFullYear(), startCivil.getUTCMonth() + 1, startCivil.getUTCDate(), zone,
  );

  const endCivil = new Date(Date.UTC(local.year, local.month - 1, local.day - backDays + 7));
  const end = zonedMidnightToUtc(
    endCivil.getUTCFullYear(), endCivil.getUTCMonth() + 1, endCivil.getUTCDate(), zone,
  );

  return { start, end, weekStartsOn: wsd, timeZone: zone };
}

/** Whole-minute "Xh Ym" (drops a trailing "0m" only when hours are also 0? no — always Xh Ym). */
export function humanHm(totalMinutes) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, '0')}m`;
}

/**
 * Progress summary from a configured target and the completed total.
 *
 * A target of 0 / null / undefined means the company has NOT configured a weekly
 * requirement — `configured:false`, and the UI shows no weekly block (§K). When
 * configured, remaining never goes negative and percent is clamped to 0..100 for
 * the bar (overtime is still visible via completed > target).
 */
export function summarizeWeekly({ targetHours = null, completedMinutes = 0 }) {
  const target = Number(targetHours);
  const configured = Number.isFinite(target) && target > 0;
  const done = Math.max(0, Math.round(Number(completedMinutes) || 0));
  const targetMinutes = configured ? Math.round(target * 60) : 0;
  const remainingMinutes = configured ? Math.max(0, targetMinutes - done) : 0;
  const percent = configured ? Math.min(100, Math.round((done / targetMinutes) * 100)) : 0;
  return {
    configured,
    completedMinutes: done,
    completedText: humanHm(done),
    targetMinutes,
    targetText: configured ? humanHm(targetMinutes) : null,
    remainingMinutes,
    remainingText: configured ? humanHm(remainingMinutes) : null,
    percent,
    overtime: configured && done > targetMinutes,
  };
}

/* ---------------------------------------------------------------------------
 * MY HOURS — period windows + exact H/M/S formatting (spec Change 4).
 *
 * The BCBA "My Hours" card aggregates the SAME authoritative SessionTimeRecord
 * time (worked-time only; no pay) over a selectable period. Like the weekly
 * window above, every window is a half-open [start, end) UTC interval resolved
 * in the COMPANY timezone with the COMPANY week-start day — never a rolling
 * 7/14/N-day window off the raw server clock — so week/bi-week honour
 * weekStartsOn and month/3-/6-month/year honour calendar-month boundaries, and
 * all of it is DST-correct because the boundaries go through zonedMidnightToUtc.
 * ------------------------------------------------------------------------- */

/** The set of period keys the card offers. `week` is the default. */
export const MY_HOURS_PERIODS = ['week', 'biweek', 'month', '3months', '6months', 'year'];

/** Calendar-month-aligned span of `count` whole months ending WITH the current
 *  month, in the given zone: [first-of-(thisMonth-(count-1)), first-of-next-month). */
function monthsSpanWindow(local, count, zone) {
  const startCivil = new Date(Date.UTC(local.year, (local.month - 1) - (count - 1), 1));
  const endCivil = new Date(Date.UTC(local.year, (local.month - 1) + 1, 1));
  const start = zonedMidnightToUtc(startCivil.getUTCFullYear(), startCivil.getUTCMonth() + 1, startCivil.getUTCDate(), zone);
  const end = zonedMidnightToUtc(endCivil.getUTCFullYear(), endCivil.getUTCMonth() + 1, endCivil.getUTCDate(), zone);
  return { start, end };
}

/**
 * Resolve one of the six "My Hours" periods to a half-open [start, end) window.
 *
 * @param {Date}   now          instant to locate (server clock)
 * @param {string} timeZone     IANA zone (org.timezone)
 * @param {number} weekStartsOn 0=Sun … 6=Sat (company setting) — used by week/bi-week
 * @param {string} period       one of MY_HOURS_PERIODS; unknown falls back to 'week'
 */
export function companyPeriodWindow(now, timeZone, weekStartsOn = 0, period = 'week') {
  const zone = timeZone || 'UTC';
  const key = MY_HOURS_PERIODS.includes(period) ? period : 'week';

  if (key === 'week') return { ...companyWeekWindow(now, zone, weekStartsOn), period: 'week' };

  if (key === 'biweek') {
    // The current fortnight: this company week plus the one before it, so the
    // window always contains today and respects weekStartsOn. End = this week's
    // end; start = this week's start shifted back 7 civil days (DST-safe).
    const wsd = ((Number(weekStartsOn) % 7) + 7) % 7;
    const local = zonedParts(now, zone);
    const backDays = ((local.weekday - wsd) + 7) % 7;
    const startCivil = new Date(Date.UTC(local.year, local.month - 1, local.day - backDays - 7));
    const endCivil = new Date(Date.UTC(local.year, local.month - 1, local.day - backDays + 7));
    const start = zonedMidnightToUtc(startCivil.getUTCFullYear(), startCivil.getUTCMonth() + 1, startCivil.getUTCDate(), zone);
    const end = zonedMidnightToUtc(endCivil.getUTCFullYear(), endCivil.getUTCMonth() + 1, endCivil.getUTCDate(), zone);
    return { start, end, weekStartsOn: wsd, timeZone: zone, period: 'biweek' };
  }

  const local = zonedParts(now, zone);
  const count = { month: 1, '3months': 3, '6months': 6, year: 12 }[key];
  const { start, end } = monthsSpanWindow(local, count, zone);
  return { start, end, timeZone: zone, period: key };
}

/** Split a whole-second total into { hours, minutes, seconds }. */
export function splitHms(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}

/** Exact "Xh Ym Zs" — hours, minutes AND seconds are always shown (spec Change 4). */
export function humanHms(totalSeconds) {
  const { hours, minutes, seconds } = splitHms(totalSeconds);
  return `${hours}h ${minutes}m ${seconds}s`;
}
