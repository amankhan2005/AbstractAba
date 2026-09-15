import { minutesToBillableUnits } from '../../domain/units.js';
import { civilDayNumber, lastCoveredDayNumber } from '../../domain/businessDate.js';
import { schedulingError } from './scheduling.errors.js';

/**
 * Pure scheduling rules, free of I/O so they are unit-tested directly. The
 * service composes these over data loaded from the repository and cross-module
 * ports. All time reasoning is in UTC for determinism.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minute-of-day (UTC) for a Date. */
export function minuteOfDayUTC(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

/**
 * Validate the appointment window; returns the duration in minutes or throws.
 *
 * The same-day restriction exists because per-weekday availability can only be
 * checked against a single weekday — it is an availability constraint, not a
 * scheduling one. Two corrections (onboarding §7/§19):
 *
 *   • the day is now the BUSINESS day (org timezone), not the UTC day, so a
 *     US-evening appointment that crosses UTC midnight is no longer rejected;
 *   • a DATE-ONLY appointment is exempt. Date-only appointments deliberately
 *     span whole business days and may legitimately span several; they carry no
 *     clock time, so there is no per-weekday availability window to check them
 *     against. Keeping the old blanket rule here would have rejected every
 *     multi-day booking the moment the end date started being honoured.
 */
export function validateTimeRange(startAt, endAt, { timeZone = 'UTC', timeSet = true } = {}) {
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  const end = endAt instanceof Date ? endAt : new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw schedulingError('INVALID_TIME_RANGE');
  }
  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  if (!timeSet) return durationMinutes; // whole-business-day appointment
  // A timed appointment must sit inside one business day (org timezone). The
  // end bound is exclusive, so an appointment ending exactly at midnight still
  // belongs to the day before it.
  const sameDay = civilDayNumber(start, timeZone) === lastCoveredDayNumber(start, end, timeZone);
  if (!sameDay || durationMinutes > 1440) throw schedulingError('INVALID_TIME_RANGE');
  return durationMinutes;
}

/**
 * Default authorization units for a duration. Delegates to the ONE canonical
 * unit rule (domain/units.js) so scheduling, sessions and billing never drift
 * into slightly different formulas (spec Module 6 Part 10).
 */
export function defaultUnits(durationMinutes) {
  return minutesToBillableUnits(durationMinutes);
}

/** True when [aStart,aEnd) and [bStart,bEnd) overlap. */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

/**
 * True when the appointment falls entirely within one of the staff member's
 * availability windows for that weekday and effective date range. With no
 * windows defined, the staff member is considered unavailable.
 */
export function isWithinAvailability(startAt, endAt, windows) {
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  const end = endAt instanceof Date ? endAt : new Date(endAt);
  const weekday = start.getUTCDay();
  const startMin = minuteOfDayUTC(start);
  const endMin = minuteOfDayUTC(end) === 0 && end.getTime() > start.getTime() ? 1440 : minuteOfDayUTC(end);
  const dayStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  return windows.some((w) => {
    if (w.dayOfWeek !== weekday) return false;
    if (w.startMinute > startMin || w.endMinute < endMin) return false;
    if (w.effectiveFrom && new Date(w.effectiveFrom).getTime() > dayStart.getTime() + DAY_MS - 1) return false;
    if (w.effectiveTo && new Date(w.effectiveTo).getTime() < dayStart.getTime()) return false;
    return true;
  });
}

/**
 * Validate an authorization for a booking. Throws AUTHORIZATION_INVALID for a
 * mismatched client / inactive status / out-of-range date, and
 * AUTHORIZATION_EXHAUSTED when insufficient units remain.
 */
export function validateAuthorization(auth, { clientId, startAt, endAt, units }) {
  if (!auth || auth.clientId !== clientId) throw schedulingError('AUTHORIZATION_INVALID');
  if (auth.status !== 'ACTIVE') throw schedulingError('AUTHORIZATION_INVALID');
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  const end = endAt instanceof Date ? endAt : new Date(endAt);
  if (auth.startDate && new Date(auth.startDate).getTime() > start.getTime()) throw schedulingError('AUTHORIZATION_INVALID');
  if (auth.endDate) {
    // endDate is a date-only calendar bound (ABA/FBA authorizations are stored
    // at UTC midnight of the last authorized day). The authorization covers the
    // WHOLE of that day, so the last bookable instant is the end of endDate's
    // day — not its 00:00 start. Comparing the appointment's end against
    // UTC-midnight rejected EVERY same-day session on the final authorized day:
    // e.g. an auth valid 09/02–09/10 refused a 09/10 booking with
    // AUTHORIZATION_INVALID (422), even though 09/10 is inside the window. Treat
    // the bound as inclusive of the whole calendar day by comparing against the
    // exclusive next-midnight. Out-of-window bookings (09/11+) are still
    // rejected — this fixes an inclusive/exclusive boundary error, it does not
    // widen the authorization.
    const e = new Date(auth.endDate);
    const authEndExclusive = Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate()) + DAY_MS;
    if (end.getTime() > authEndExclusive) throw schedulingError('AUTHORIZATION_INVALID');
  }
  const remaining = (auth.authorizedUnits ?? 0) - (auth.usedUnits ?? 0);
  if (remaining < units) throw schedulingError('AUTHORIZATION_EXHAUSTED');
}

/**
 * Authorization USABILITY, shared by booking and manual session entry. A
 * session may only be recorded against an authorization in a usable state:
 * the bookable adapter maps an APPROVED ABA/FBA ServiceAuthorization to status
 * 'ACTIVE' (anything else to 'PENDING'); legacy Authorization records use
 * 'ACTIVE'.
 */
export const BOOKABLE_AUTH_STATUSES = new Set(['ACTIVE', 'APPROVED']);
export function isBookableAuthorization(auth) {
  return Boolean(auth) && BOOKABLE_AUTH_STATUSES.has(auth.status);
}

/**
 * Whether an authorization's validity window covers a business date
 * ('YYYY-MM-DD'). Authorization start/end dates are date-only calendar bounds
 * (stored at UTC midnight), both INCLUSIVE, so they are compared as calendar
 * dates — never as instants, which would shift the last authorized day in a
 * non-UTC organization.
 */
export function authorizationCoversDate(auth, dateString) {
  if (!auth) return false;
  const civil = (v) => {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const start = civil(auth.startDate);
  const end = civil(auth.endDate);
  if (start && dateString < start) return false;
  if (end && dateString > end) return false;
  return true;
}

/** A client is bookable unless archived or discharged. */
export function assertClientBookable(client) {
  if (!client) throw schedulingError('CLIENT_NOT_BOOKABLE');
  if (client.status === 'ARCHIVED' || client.status === 'DISCHARGED') throw schedulingError('CLIENT_NOT_BOOKABLE');
}

/** A staff member is eligible when active and holding at least one active credential. */
export function assertStaffEligible(staff, credentials) {
  if (!staff || staff.status !== 'ACTIVE') throw schedulingError('STAFF_NOT_ELIGIBLE');
  const hasActiveCredential = (credentials ?? []).some((c) => c.status === 'ACTIVE');
  if (!hasActiveCredential) throw schedulingError('STAFF_NOT_ELIGIBLE');
}
