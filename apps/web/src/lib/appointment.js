import { formatDate, formatDateTime, formatTime } from './format.js';
import { civilDateString, lastCoveredDayNumber, startEligibility } from './businessDate.js';

/**
 * Client-side use of the ONE session start rule (`startEligibility`, mirrored
 * from apps/api/src/domain/businessDate.js): each scheduled date opens a
 * 24-hour start window at the scheduled start (org-timezone midnight for a
 * date-only booking). This drives which appointments the Start Session panel
 * lists, the disabled state of Start buttons and the Expired badge, so the user
 * isn't surprised by a 409. The server (APPOINTMENT_NOT_TODAY) independently
 * recomputes the same rule on its own clock and remains the authority.
 */

/**
 * 'UPCOMING' | 'AVAILABLE' | 'EXPIRED' for an appointment or panel card. An
 * EXPIRED verdict from the server always stands (expiry never reverses);
 * otherwise the live clock decides, so an open screen flips the moment a
 * window opens or closes (see useStartWindowClock) without a refetch.
 */
export function appointmentStartStatus(appt, timeZone, now = new Date()) {
  if (!appt || !appt.startAt) return 'AVAILABLE';
  if (appt.startStatus === 'EXPIRED' || appt.expired === true) return 'EXPIRED';
  return appointmentOccurrence(appt, timeZone, now).status;
}

/**
 * The scheduled OCCURRENCE a card represents, as a start-eligibility result
 * ({ status, businessDate, windowStart, windowEnd }). Each date in a
 * multi-date appointment is its own occurrence:
 *   - a card with a live (running/stopped) session is its session's own date
 *     (`sessionBusinessDate` from the server) — never today's window;
 *   - otherwise the date whose window is open now, or the next / last one.
 * It is never the appointment's range start.
 */
export function appointmentOccurrence(appt, timeZone, now = new Date()) {
  const zone = timeZone || 'UTC';
  const live = appt?.sessionStatus === 'IN_PROGRESS' || appt?.sessionStatus === 'STOPPED';
  const bound = live && appt?.sessionBusinessDate ? { businessDate: appt.sessionBusinessDate } : {};
  return startEligibility(appt ?? {}, zone, now, bound);
}

/**
 * The occurrence as the clinician reads it, in the org timezone:
 *   date-only  "09/13/2026"            (or "Today")
 *   timed      "09/13/2026 · 10:00 AM – 11:00 AM" for a single-date
 *              appointment, "09/13/2026 · 10:00 AM" for a multi-date one.
 * The date is the OCCURRENCE's business date — for a 09/12 → 09/30 booking on
 * 09/13 it reads 09/13, never 09/12 and never the whole range.
 */
export function occurrenceText(appt, timeZone, now = new Date(), { todayLabel = false } = {}) {
  if (!appt?.startAt) return '';
  const zone = timeZone || 'UTC';
  const occ = appointmentOccurrence(appt, zone, now);
  const date = todayLabel && occ.businessDate === civilDateString(now, zone) ? 'Today' : formatDate(occ.businessDate);
  if (appt.timeSet === false) return date;
  const singleDate = civilDateString(appt.startAt, zone) === civilDateString(new Date(new Date(appt.endAt ?? appt.startAt).getTime() - 1), zone);
  const start = formatTime(occ.windowStart, zone);
  return singleDate && appt.endAt ? `${date} · ${start} – ${formatTime(appt.endAt, zone)}` : `${date} · ${start}`;
}

/** True while one of the appointment's 24-hour start windows is open. */
export function isStartableNow(appt, timeZone, now = new Date()) {
  return appointmentStartStatus(appt, timeZone, now) === 'AVAILABLE';
}

/** True once the appointment's last 24-hour start window has closed. */
export function isExpiredAppointment(appt, timeZone, now = new Date()) {
  return appointmentStartStatus(appt, timeZone, now) === 'EXPIRED';
}

/**
 * A short, friendly reason for a disabled Start button — never a raw error
 * code, always MM/DD/YYYY in the org timezone. Returns null when startable.
 *   upcoming timed      "Available from 09/14/2026 10:00 AM"
 *   upcoming date-only  "Available on 09/14/2026"
 *   expired             "Expired — start window closed 09/13/2026 10:00 AM"
 */
export function startabilityLabel(appt, timeZone, now = new Date()) {
  const status = appointmentStartStatus(appt, timeZone, now);
  if (status === 'AVAILABLE' || !appt?.startAt) return null;
  const zone = timeZone || 'UTC';
  const e = appointmentOccurrence(appt, zone, now);
  if (status === 'UPCOMING') {
    return appt.timeSet === false
      ? `Available on ${formatDate(e.businessDate)}`
      : `Available from ${formatDateTime(e.windowStart, zone)}`;
  }
  const closedAt = appt.startWindowEnd && appt.startStatus === 'EXPIRED' ? appt.startWindowEnd : e.windowEnd;
  return `Expired — start window closed ${formatDateTime(closedAt, zone)}`;
}

/**
 * Group session cards by the start rule, never by calendar date:
 *   current   a start window is open now, or a session is live (running/stopped)
 *   upcoming  the next window has not opened yet
 *   expired   every window has closed and nothing is live (shown not-startable)
 */
export function groupSessionCards(cards = [], timeZone, now = new Date()) {
  const out = { current: [], upcoming: [], expired: [] };
  for (const c of cards) {
    const live = c.sessionStatus === 'IN_PROGRESS' || c.sessionStatus === 'STOPPED';
    const status = appointmentStartStatus(c, timeZone, now);
    if (live || status === 'AVAILABLE') out.current.push(c);
    else if (status === 'UPCOMING') out.upcoming.push(c);
    else out.expired.push(c);
  }
  return out;
}

/**
 * The next instant after `now` at which any card's start window opens or
 * closes — when the Start Session panel must re-render. Null when none.
 */
export function nextStartBoundary(cards = [], timeZone, now = new Date()) {
  const t = new Date(now).getTime();
  let best = null;
  for (const c of cards) {
    if (!c?.startAt) continue;
    const e = appointmentOccurrence(c, timeZone || 'UTC', now);
    for (const b of [e.windowStart, e.windowEnd]) {
      const ms = b ? new Date(b).getTime() : NaN;
      if (ms > t && (best === null || ms < best)) best = ms;
    }
  }
  return best === null ? null : new Date(best);
}

/**
 * The LAST business day this appointment is scheduled for (calendar display),
 * as a civil day number.
 */
export function inclusiveEndDayNumber(appt, timeZone) {
  if (!appt?.startAt) return null;
  return lastCoveredDayNumber(appt.startAt, appt.endAt ?? appt.startAt, timeZone || 'UTC');
}

