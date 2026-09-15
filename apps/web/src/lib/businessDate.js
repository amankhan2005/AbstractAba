/**
 * Client-side mirror of the API's ONE business-date authority
 * (apps/api/src/domain/businessDate.js). The organization's timezone decides
 * what day something is on — never the browser's.
 *
 * This file exists because the web client cannot import from the API package,
 * so the rule is mirrored rather than shared. It is deliberately tiny and has
 * no behaviour of its own: the server remains the authority (it re-checks every
 * gate), and this mirror only drives what the calendar marks and whether the
 * Start button is enabled, so the user is never surprised by a 409.
 *
 * THE ONE RULE (identical to the API):
 *   an appointment occupies [startAt, endAt), and its business days are the
 *   org-timezone civil days that interval touches — civilDay(startAt) through
 *   civilDay(endAt - 1ms).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' for an instant in a timezone. */
export function civilDateString(value, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

/** Comparable civil day number (YYYYMMDD) for an instant in a timezone. */
export function civilDayNumber(value, timeZone) {
  const s = civilDateString(value, timeZone);
  const [y, m, d] = s.split('-').map(Number);
  return y * 10000 + m * 100 + d;
}

/**
 * The LAST business day the appointment touches. `endAt` is an EXCLUSIVE bound
 * (a date-only appointment ends at org midnight of the following day), so the
 * last covered day is the one containing endAt-1ms. Reading endAt's own day
 * would mark one day too many on the calendar.
 */
export function lastCoveredDayNumber(startAt, endAt, timeZone) {
  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : start;
  const inclusive = end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : start;
  return civilDayNumber(inclusive, timeZone);
}

/** True when `now`'s CALENDAR business day is covered (calendar display only — NOT the start gate; see startEligibility). */
export function coversBusinessDay(startAt, endAt, timeZone, now = new Date()) {
  if (!startAt) return true;
  const today = civilDayNumber(now, timeZone);
  return today >= civilDayNumber(startAt, timeZone)
    && today <= lastCoveredDayNumber(startAt, endAt, timeZone);
}

/**
 * Every business date the appointment covers, as 'YYYY-MM-DD' strings, both
 * ends inclusive. A multi-day appointment therefore appears on EVERY scheduled
 * date rather than only on the day it was created (onboarding §7).
 */
export function coveredBusinessDates(startAt, endAt, timeZone, maxDays = 400) {
  if (!startAt) return [];
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return [];
  const first = civilDateString(start, timeZone);
  const [fy, fm, fd] = first.split('-').map(Number);
  const lastNumber = lastCoveredDayNumber(startAt, endAt, timeZone);
  const out = [];
  let cursor = Date.UTC(fy, fm - 1, fd);
  for (let i = 0; i < maxDays; i += 1) {
    const d = new Date(cursor);
    const num = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    if (num > lastNumber) break;
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
    cursor += DAY_MS;
  }
  return out;
}

/** A session start window is EXACTLY 24 hours of elapsed time (mirror of the API). */
export const START_WINDOW_MS = 24 * 60 * 60 * 1000;

function zonedParts(date, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** UTC instant for a wall-clock time on a civil date in a zone (DST-correct; mirror of the API). */
export function zonedWallTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetAt = (ms) => {
    const p = zonedParts(new Date(ms), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  const guess = naive - offsetAt(naive);
  return new Date(naive - offsetAt(guess));
}

function addCivilDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/**
 * MIRROR of the API's startEligibility (apps/api/src/domain/businessDate.js) —
 * the ONE session start rule. Timestamp-based, never "date === today":
 * each scheduled business date opens a start window at the scheduled start
 * (org-timezone midnight for a date-only booking) that closes exactly 24 hours
 * later. Returns { status: 'UPCOMING'|'AVAILABLE'|'EXPIRED', businessDate,
 * windowStart, windowEnd }. The server remains the authority and re-checks.
 *
 * With `{ businessDate }` it describes ONLY that scheduled date's own window
 * (each date in a multi-date range is its own occurrence).
 */
export function startEligibility({ startAt, endAt, timeSet } = {}, timeZone, now = new Date(), { businessDate: occurrence = null } = {}) {
  if (!startAt) return { status: 'AVAILABLE', businessDate: null, windowStart: null, windowEnd: null };
  const zone = timeZone || 'UTC';
  const start = new Date(startAt);
  const firstDate = civilDateString(start, zone);
  const lastDate = lastCoveredDateString(start, endAt ?? start, zone);
  const clock = zonedParts(start, zone);

  const windowFor = (date) => {
    const [y, m, d] = date.split('-').map(Number);
    let open;
    if (timeSet === false) open = zonedWallTimeToUtc(y, m, d, 0, 0, 0, zone);
    else if (date === firstDate) open = start;
    else open = zonedWallTimeToUtc(y, m, d, clock.hour, clock.minute, clock.second, zone);
    return { businessDate: date, windowStart: open, windowEnd: new Date(open.getTime() + START_WINDOW_MS) };
  };

  const t = new Date(now).getTime();

  if (occurrence) {
    const w = windowFor(occurrence);
    if (t < w.windowStart.getTime()) return { status: 'UPCOMING', ...w };
    if (t >= w.windowEnd.getTime()) return { status: 'EXPIRED', ...w };
    return { status: 'AVAILABLE', ...w };
  }

  const first = windowFor(firstDate);
  if (t < first.windowStart.getTime()) return { status: 'UPCOMING', ...first };
  const last = windowFor(lastDate);
  if (t >= last.windowEnd.getTime()) return { status: 'EXPIRED', ...last };

  const today = civilDateString(new Date(t), zone);
  let next = null;
  for (const offset of [-2, -1, 0, 1]) {
    const date = addCivilDays(today, offset);
    if (date < firstDate || date > lastDate) continue;
    const w = windowFor(date);
    if (t >= w.windowStart.getTime() && t < w.windowEnd.getTime()) return { status: 'AVAILABLE', ...w };
    if (t < w.windowStart.getTime() && (!next || w.windowStart < next.windowStart)) next = w;
  }
  return { status: 'UPCOMING', ...(next ?? last) };
}

/** The last covered business date as 'YYYY-MM-DD' (inclusive). */
export function lastCoveredDateString(startAt, endAt, timeZone) {
  if (!startAt) return null;
  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : start;
  const inclusive = end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : start;
  return civilDateString(inclusive, timeZone || 'UTC');
}

/**
 * The business dates of a half-open [from, to) window as { first, last }
 * 'YYYY-MM-DD' strings in the org timezone — e.g. the My Hours week
 * Monday 09/07 → Sunday 09/13. `to` is exclusive, so the last day is to-1ms.
 */
export function windowDateStrings(from, to, timeZone) {
  if (!from || !to) return null;
  const zone = timeZone || 'UTC';
  return { first: civilDateString(from, zone), last: civilDateString(new Date(new Date(to).getTime() - 1), zone) };
}

/**
 * MIRROR of the API's currentMonthBookingWindow: a NEW appointment may cover
 * business dates from today through the last day of the current month, in the
 * organization timezone. Returns { today, lastAllowed } as 'YYYY-MM-DD'. The
 * server enforces the same window and refuses anything outside it.
 */
export function currentMonthBookingWindow(timeZone, now = new Date()) {
  const today = civilDateString(now, timeZone || 'UTC');
  const [y, m] = today.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { today, lastAllowed: `${today.slice(0, 8)}${String(lastDay).padStart(2, '0')}` };
}
