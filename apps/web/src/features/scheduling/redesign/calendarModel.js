import { zonedWallTimeToUtc } from '@/lib/businessDate';
import { formatTime, formatDate } from '@/lib/format';
import { coveredDays } from './calendarDays.js';

/**
 * Pure calendar helpers for the Scheduling page. Every date here is a civil
 * 'YYYY-MM-DD' business date in the ORGANIZATION timezone — never a browser-local
 * Date — so the grid, "today", the selected date and the fetched range all agree
 * with the server's business calendar.
 */

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n) => String(n).padStart(2, '0');
export const civilKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const parseKey = (key) => { const [y, m, d] = key.split('-').map(Number); return { y, m, d }; };

/** Weekday index (0 = Sunday) of a civil date, from its own calendar parts. */
export const weekdayOf = (key) => { const { y, m, d } = parseKey(key); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

export function addDays(key, days) {
  const { y, m, d } = parseKey(key);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return civilKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** { year, month } of the month containing a civil date. */
export const monthOf = (key) => { const { y, m } = parseKey(key); return { year: y, month: m }; };

export function shiftMonth({ year, month }, n) {
  const t = new Date(Date.UTC(year, month - 1 + n, 1));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1 };
}

export const monthLabel = ({ year, month }) => `${MONTHS[month - 1]} ${year}`;

/** "Tuesday, 09/15/2026" */
export const longDateLabel = (key) => `${WEEKDAY_NAMES[weekdayOf(key)]}, ${formatDate(key)}`;

/** The 42 civil dates (6 weeks, Sunday first) shown for a month. */
export function monthGrid({ year, month }) {
  const first = civilKey(year, month, 1);
  const start = addDays(first, -weekdayOf(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/**
 * The instant range to load for a month grid: org-timezone midnight of the first
 * visible day (less `leadDays`, so a multi-day appointment that began shortly
 * before the grid still marks its visible days) → the end of the last visible day.
 */
export function gridRange(grid, timeZone, leadDays = 31) {
  const from = parseKey(addDays(grid[0], -leadDays));
  const after = parseKey(addDays(grid[grid.length - 1], 1));
  const zone = timeZone || 'UTC';
  return {
    from: zonedWallTimeToUtc(from.y, from.m, from.d, 0, 0, 0, zone).toISOString(),
    to: new Date(zonedWallTimeToUtc(after.y, after.m, after.d, 0, 0, 0, zone).getTime() - 1).toISOString(),
  };
}

/**
 * Load EVERY appointment in a range through the existing list endpoint, page by
 * page (max page size 100) using its cursor. One logical request per visible
 * range — never one request per appointment. `maxPages` bounds a runaway loop.
 */
export async function fetchAppointmentRange(listAppointments, params, { maxPages = 20 } = {}) {
  const items = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await listAppointments({ ...params, limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...(res.items ?? []));
    cursor = res.meta?.nextCursor;
    if (!cursor) return { items, complete: true };
  }
  return { items, complete: false };
}

/** Appointments bucketed by every business date they cover. */
export function bucketByDay(appointments, timeZone) {
  const map = new Map();
  for (const a of appointments) {
    if (!a?.startAt) continue;
    for (const key of coveredDays(a.startAt, a.endAt, timeZone)) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    }
  }
  for (const list of map.values()) list.sort(compareAppointments);
  return map;
}

/** Timed appointments first by start instant; date-only ones after, by client. */
export function compareAppointments(a, b) {
  const at = a.timeSet === false ? 1 : 0;
  const bt = b.timeSet === false ? 1 : 0;
  if (at !== bt) return at - bt;
  const byStart = String(a.startAt ?? '').localeCompare(String(b.startAt ?? ''));
  if (byStart !== 0) return byStart;
  return String(a.clientName ?? '').localeCompare(String(b.clientName ?? ''));
}

/**
 * The scheduled time to DISPLAY. A date-only appointment (timeSet === false)
 * has no clock time, so nothing is shown — never a fabricated midnight.
 */
export function scheduledTimeLabel(a, timeZone) {
  if (!a?.startAt || a.timeSet === false) return '';
  const start = formatTime(a.startAt, timeZone);
  const end = a.endAt ? formatTime(a.endAt, timeZone) : '';
  return end ? `${start} – ${end}` : start;
}

/** "09/13/2026 – 09/30/2026" for an appointment covering several business dates, else ''. */
export function dateSpanLabel(a, timeZone) {
  const days = coveredDays(a?.startAt, a?.endAt, timeZone);
  return days.length > 1 ? `${formatDate(days[0])} – ${formatDate(days[days.length - 1])}` : '';
}

/** Semantic status → tone (the app's shared status colours). */
export const STATUS_TONE = { SCHEDULED: 'info', COMPLETED: 'approved', CANCELLED: 'denied', NO_SHOW: 'pending' };
export const STATUS_LABEL = { SCHEDULED: 'Scheduled', COMPLETED: 'Completed', CANCELLED: 'Cancelled', NO_SHOW: 'No show' };

/** Does an appointment match the page's server-side filters (used for cache updates)? */
export function matchesFilters(a, { clientId, staffProfileId, status } = {}) {
  if (clientId && a.clientId !== clientId) return false;
  if (staffProfileId && a.staffProfileId !== staffProfileId) return false;
  if (status && a.status !== status) return false;
  return true;
}

/** Insert or replace an appointment in a loaded range, when it belongs there. */
export function upsertInRange(data, appt, params) {
  if (!data || !Array.isArray(data.items) || !appt?.id) return data;
  const rest = data.items.filter((x) => x.id !== appt.id);
  const t = new Date(appt.startAt).getTime();
  const inRange = (!params?.from || t >= Date.parse(params.from)) && (!params?.to || t <= Date.parse(params.to));
  if (!inRange || !matchesFilters(appt, params)) return rest.length === data.items.length ? data : { ...data, items: rest };
  return { ...data, items: [...rest, appt] };
}
