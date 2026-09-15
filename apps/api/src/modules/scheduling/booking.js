import { schedulingError } from './scheduling.errors.js';
import {
  businessDayRange, businessInstant, parseCivilDate, parseClockMinutes,
  DATE_ONLY_RE, civilDateString, lastBusinessDateString
} from '../../domain/businessDate.js';

/**
 * ---------------------------------------------------------------------------
 * NEW SIMPLE BOOKING CORE (rebuild).
 *
 * Pure, I/O-free helpers for the rebuilt "Book Appointment" pipeline. Keeping
 * the shape/date/units reasoning here — with zero database or network calls —
 * is what makes the create path deterministic and trivially unit-testable, and
 * is a large part of why the endpoint can never hang: everything below either
 * returns a value or throws a structured error synchronously.
 *
 * The canonical booking the service acts on is:
 *   { clientId, bcbaId, rbtId, staffProfileId, authorizationIds,
 *     authorizationId, startAt, endAt, units, notes }
 *
 * The frontend sends separate care-team roles (bcbaId + rbtId), a list of
 * authorizations (authorizationIds), calendar dates (startDate/endDate) and
 * clock times (startTime/endTime) plus units.
 *
 * DATE HANDLING (rewritten — onboarding §6/§7/§8/§19/§20). The wall-clock
 * values the admin typed are interpreted in the ORGANIZATION's timezone, which
 * is the business authority. This module previously composed them as UTC
 * instants, which is what made a New York clinic's 09/12 booking land on 09/11
 * for the Start gate, and an IST-entered evening time render on 09/13 in the
 * calendar. Two behaviours follow from the corrected contract:
 *
 *   DATE-ONLY (no clock time — the normal case; the booking form does not
 *   collect a time). The appointment covers WHOLE business days:
 *       startAt = org midnight at the start of startDate
 *       endAt   = org midnight at the start of the day AFTER endDate
 *   so 09/12 → 09/14 covers 09/12, 09/13 and 09/14, expires on 09/15, and a
 *   single-day 09/12 → 09/12 stays valid for the whole of the 09/12 business
 *   day. `endAt` is the EXCLUSIVE bound, which is what makes "expires when the
 *   business date becomes 09/13" exact.
 *
 *   TIMED. startAt/endAt are the exact org-timezone instants. `endDate` is now
 *   honoured here too: it used to be computed and then silently discarded
 *   whenever no endTime was supplied, which collapsed EVERY multi-day booking
 *   to a units-long window on the start day.
 * ---------------------------------------------------------------------------
 */

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/**
 * Resolve a supplied date part to a civil 'YYYY-MM-DD' date in the business
 * timezone. Accepts the 'YYYY-MM-DD' the DateInput emits, and tolerates a full
 * ISO instant from a legacy caller by reading its civil date in the org zone.
 */
function toCivilDate(datePart, timeZone) {
  if (typeof datePart !== 'string' || datePart.trim() === '') return null;
  const d = datePart.trim();
  if (DATE_ONLY_RE.test(d)) return parseCivilDate(d) ? d : null;
  const instant = new Date(d);
  if (Number.isNaN(instant.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
  return DATE_ONLY_RE.test(p) ? p : null;
}

/** Minutes past midnight for a legacy full-ISO instant, read in the business zone. */
function zonedMinuteOfDay(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return (get('hour') % 24) * 60 + get('minute');
}

/**
 * Normalize a booking request (new OR legacy shape) into the single canonical
 * object the service acts on. Throws a structured 422 for any structural
 * problem so the controller always returns a terminal response — never a hang.
 *
 * Validations performed here (spec §5–§8):
 *   • at least one authorization is selected               → NO_AUTHORIZATION
 *   • units are present, numeric, and > 0                  → UNITS_INVALID
 *   • a start instant can be resolved                      → INVALID_TIME_RANGE
 *   • end is on/after start                                → END_BEFORE_START
 */
export function normalizeBookingInput(input = {}, { timeZone = 'UTC' } = {}) {
  const clientId = input.clientId;
  const zone = timeZone || 'UTC';

  // Care-team roles. New shape sends bcbaId + rbtId; a legacy caller may send
  // only staffProfileId (treated as the RBT). staffProfileId always mirrors the
  // RBT so downstream Sessions/Billing/Payroll keep working unchanged.
  const rbtId = input.rbtId ?? input.staffProfileId ?? null;
  const bcbaId = input.bcbaId ?? null;
  const staffProfileId = rbtId ?? bcbaId ?? null;

  // Authorizations. New shape sends authorizationIds[]; a legacy caller may send
  // a single authorizationId.
  let authorizationIds = [];
  if (Array.isArray(input.authorizationIds)) authorizationIds = input.authorizationIds.filter(Boolean);
  else if (input.authorizationId) authorizationIds = [input.authorizationId];
  // De-duplicate while preserving order (first stays primary).
  authorizationIds = [...new Set(authorizationIds)];
  if (authorizationIds.length === 0) throw schedulingError('NO_AUTHORIZATION');
  const authorizationId = authorizationIds[0];

  // Units — required, numeric, > 0.
  const units = Number(input.units);
  if (!Number.isFinite(units) || !Number.isInteger(units) || units <= 0) {
    throw schedulingError('UNITS_INVALID');
  }

  // --- TIME WINDOW (business dates, org timezone) --------------------------
  // `timeSet` records whether a real clock time was actually supplied. When only
  // dates are given (the normal path — the booking form deliberately collects no
  // clock time) the appointment is DATE-ONLY and covers WHOLE business days, so
  // it is available for the entire scheduled day and no fabricated clock time is
  // ever displayed (onboarding §20/§21).
  const startDate = toCivilDate(input.startAt ?? input.startDate, zone);
  if (!startDate) throw schedulingError('INVALID_TIME_RANGE');
  const endDate = toCivilDate(input.endAt ?? input.endDate, zone) ?? startDate;

  const startMinutes = input.startAt
    ? zonedMinuteOfDay(input.startAt, zone)
    : parseClockMinutes(input.startTime);
  const endMinutes = input.endAt
    ? zonedMinuteOfDay(input.endAt, zone)
    : parseClockMinutes(input.endTime);
  const hasClockTime = startMinutes !== null && startMinutes !== undefined;

  let startAt;
  let endAt;

  if (!hasClockTime) {
    // DATE-ONLY. The end date is INCLUSIVE (§7): businessDayRange returns the
    // exclusive upper bound at org midnight of the day AFTER endDate, so
    // 09/12 → 09/14 covers three whole days and expires on 09/15.
    const range = businessDayRange(startDate, endDate, zone);
    if (!range) {
      // A null range here means endDate precedes startDate (an inverted range);
      // an unparseable startDate was already rejected above.
      throw schedulingError('END_BEFORE_START');
    }
    startAt = range.startAt;
    endAt = range.endAt;
  } else {
    startAt = businessInstant(startDate, startMinutes, zone);
    if (!startAt) throw schedulingError('INVALID_TIME_RANGE');
    if (endMinutes !== null && endMinutes !== undefined) {
      // endDate is honoured here — it used to be computed and then dropped on
      // this branch, which is what silently collapsed multi-day bookings.
      endAt = businessInstant(endDate, endMinutes, zone);
    } else {
      // No end time supplied. Derive from units (one billable unit = 15 min).
      // If the booking spans SEVERAL days, the derived end would stop on the
      // first one, so a multi-day timed booking is extended to cover its whole
      // range. A single-day booking keeps its exact units-derived end — it must
      // not be stretched to the end of the day.
      const derived = new Date(startAt.getTime() + units * FIFTEEN_MIN_MS);
      if (endDate !== startDate) {
        const range = businessDayRange(startDate, endDate, zone);
        endAt = range && range.endAt.getTime() > derived.getTime() ? range.endAt : derived;
      } else {
        endAt = derived;
      }
    }
  }

  if (!endAt || Number.isNaN(endAt.getTime())) throw schedulingError('INVALID_TIME_RANGE');
  if (endAt.getTime() <= startAt.getTime()) throw schedulingError('END_BEFORE_START');

  return {
    clientId,
    bcbaId,
    rbtId,
    staffProfileId,
    authorizationIds,
    authorizationId,
    startAt,
    endAt,
    timeSet: hasClockTime,
    // The zone the instants above are anchored to. Persisted on the appointment
    // so every later reader knows which business calendar this row belongs to,
    // and so the migration can tell a corrected row from a legacy one.
    businessTimeZone: zone,
    units,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
}

/**
 * Assert the given staff member holds an ACTIVE care-team assignment in `role`
 * for the client. `assignments` is the client's care-team list
 * (clientsRepository.listAssignments). Throws the role-specific structured 422
 * (spec §2/§3). A null staffProfileId means the caller did not select one.
 */
export function assertAssignedRole(assignments, staffProfileId, role, errorCode) {
  const active = (assignments ?? []).filter((a) => (a.status ?? 'ACTIVE') === 'ACTIVE' && a.role === role);
  if (active.length === 0) throw schedulingError(errorCode);
  if (!staffProfileId) throw schedulingError(errorCode);
  const ok = active.some((a) => a.staffProfileId === staffProfileId);
  if (!ok) throw schedulingError(errorCode);
}

/**
 * NEW-APPOINTMENT DATE WINDOW (server-enforced).
 *
 * A NEW appointment may only cover business dates from TODAY through the LAST
 * DAY OF THE CURRENT MONTH, in the organization timezone, judged by the server
 * clock. Every scheduled date must satisfy it, so for a multi-date booking the
 * first date must not be in the past and the last date must not leave the
 * current month:
 *
 *   today 09/13/2026   09/13 → 09/30 ok   09/12 → 09/20 past   09/13 → 10/05 next month
 *
 * Submitted dates are never adjusted — a violation is refused. Existing
 * (historical) appointments are untouched: this runs only on the create path.
 *
 * @returns {{ today: string, lastAllowed: string }} the window, as 'YYYY-MM-DD'
 */
export function currentMonthBookingWindow(timeZone, now = new Date()) {
  const zone = timeZone || 'UTC';
  const today = civilDateString(now, zone);
  const [y, m] = today.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { today, lastAllowed: `${today.slice(0, 8)}${String(lastDay).padStart(2, '0')}` };
}

export function assertNewAppointmentDates({ startAt, endAt, timeZone, now = new Date() }) {
  const zone = timeZone || 'UTC';
  const { today, lastAllowed } = currentMonthBookingWindow(zone, now);
  const first = civilDateString(startAt, zone);
  const last = lastBusinessDateString(startAt, endAt ?? startAt, zone);
  if (first < today) throw schedulingError('APPOINTMENT_DATE_IN_PAST', { details: { today, firstDate: first } });
  if (last > lastAllowed || first > lastAllowed) {
    throw schedulingError('APPOINTMENT_DATE_OUTSIDE_CURRENT_MONTH', { details: { today, lastAllowed, lastDate: last } });
  }
  return { today, lastAllowed, firstDate: first, lastDate: last };
}
