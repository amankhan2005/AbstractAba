import { AppError } from '../../common/errors/AppError.js';

/**
 * Pure supervision-hour calculations. Durations are integer minutes; totals are
 * derived server-side. No financial/payroll coupling — these hours are a
 * clinical-compliance metric, entirely separate from payroll time entries.
 */

/** Validate a duration is a positive integer number of minutes. */
export function assertValidMinutes(minutes) {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw AppError.validation('Duration must be a positive whole number of minutes.');
  }
  if (minutes > 24 * 60) {
    throw AppError.validation('Duration cannot exceed 24 hours.');
  }
  return minutes;
}

/** Sum a list of { minutes } records to total minutes. */
export function sumMinutes(records) {
  return records.reduce((acc, r) => acc + (Number.isInteger(r.minutes) ? r.minutes : 0), 0);
}

/** Convert minutes to hours, rounded to 2 decimals (display/summary only). */
export function minutesToHours(minutes) {
  return Math.round((minutes / 60) * 100) / 100;
}

/**
 * Build a per-supervisee summary from hour-log rows:
 *   [{ superviseeStaffId, totalMinutes, totalHours, entries }]
 */
export function summariseBySupervisee(records) {
  const map = new Map();
  for (const r of records) {
    const key = r.superviseeStaffId;
    const cur = map.get(key) ?? { superviseeStaffId: key, totalMinutes: 0, entries: 0 };
    cur.totalMinutes += Number.isInteger(r.minutes) ? r.minutes : 0;
    cur.entries += 1;
    map.set(key, cur);
  }
  return [...map.values()].map((s) => ({ ...s, totalHours: minutesToHours(s.totalMinutes) }));
}
