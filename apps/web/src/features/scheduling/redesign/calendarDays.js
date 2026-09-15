import { coveredBusinessDates } from '@/lib/businessDate';

/**
 * The business dates a (possibly multi-day) appointment covers, inclusive of
 * both ends (onboarding §7): a single-day appointment yields one date; a
 * 09/12 → 09/14 appointment yields all three, so the calendar marks every
 * scheduled date rather than only the creation date.
 *
 * TWO BUGS FIXED HERE, which used to partly cancel each other out and so looked
 * intermittent:
 *
 *   1. this function bucketed by BROWSER timezone (getFullYear/getMonth/
 *      getDate), so the same appointment landed on a different calendar square
 *      depending on who was looking at it — 09/13 from an IST browser, 09/11
 *      from a US one;
 *   2. the caller then ran each local-midnight Date back through toISOString()
 *      to build its key, shifting it AGAIN by the browser offset.
 *
 * Returning plain 'YYYY-MM-DD' business dates removes both: there is no Date
 * object left to be re-interpreted, and the zone used is the organization's.
 *
 * `endAt` is the EXCLUSIVE upper bound, so a date-only appointment ending at
 * org midnight does not mark the following day.
 *
 * @param {string|Date} startAt
 * @param {string|Date|null} endAt   exclusive upper bound
 * @param {string} timeZone          the organization's IANA zone
 * @returns {string[]} 'YYYY-MM-DD' business dates, ascending
 */
export function coveredDays(startAt, endAt, timeZone) {
  if (!startAt) return [];
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return [];
  const end = endAt ? new Date(endAt) : null;
  const usableEnd = end && !Number.isNaN(end.getTime()) ? end : null;
  if (usableEnd && usableEnd.getTime() < start.getTime()) return []; // inverted range
  return coveredBusinessDates(startAt, usableEnd, timeZone || 'UTC');
}

export default coveredDays;
