/**
 * Date-only arithmetic for the shared date picker.
 *
 * The canonical value everywhere is a civil calendar date string `YYYY-MM-DD`
 * (exactly what the forms already store and send to the API). The user-facing
 * form is always `MM/DD/YYYY`. Every calculation below runs on UTC calendar
 * parts, so a date can never shift by the viewer's timezone — there is no
 * instant involved until the server composes one in the organization timezone.
 *
 * Nothing here parses locale strings (`new Date('08/27/2015')`) and nothing
 * reads the browser's zone except `todayIso()` when no business timezone is
 * known, which mirrors the app's existing `todayLocalISO()` fallback.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const pad2 = (n) => String(n).padStart(2, '0');

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
export const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function daysInMonth(year, month /* 1-12 */) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function toIso(year, month /* 1-12 */, day) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** `YYYY-MM-DD` (a datetime prefix is tolerated) -> { y, m, d } or null when not a real date. */
export function parseIso(iso) {
  const match = ISO_RE.exec(String(iso ?? ''));
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** Internal `YYYY-MM-DD` -> visible `MM/DD/YYYY` (empty string when unset/partial). */
export function isoToDisplay(iso) {
  const match = ISO_RE.exec(String(iso ?? ''));
  return match ? `${match[2]}/${match[3]}/${match[1]}` : '';
}

/** Progressive digit mask: raw keystrokes/paste -> `MM`, `MM/DD`, `MM/DD/YYYY`. */
export function maskDisplay(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2)];
  if (digits.length > 2) parts.push(digits.slice(2, 4));
  if (digits.length > 4) parts.push(digits.slice(4, 8));
  return parts.join('/');
}

/**
 * Visible `MM/DD/YYYY` -> internal `YYYY-MM-DD`, or null when incomplete/invalid.
 * Explicit field parsing and a real calendar-validity check reject 13/40/2026,
 * 00/00/2026, 02/31/2026, etc.
 */
export function displayToIso(display) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(display ?? '').trim());
  if (!match) return null;
  const mm = Number(match[1]);
  const dd = Number(match[2]);
  const yyyy = Number(match[3]);
  if (mm < 1 || mm > 12) return null;
  if (yyyy < 1000 || yyyy > 9999) return null;
  if (dd < 1 || dd > daysInMonth(yyyy, mm)) return null;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

function fromUtc(ms) {
  const d = new Date(ms);
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addDays(iso, n) {
  const p = parseIso(iso);
  if (!p) return iso;
  return fromUtc(Date.UTC(p.y, p.m - 1, p.d + n));
}

/** Month arithmetic that clamps the day (01/31 + 1 month -> 02/28). */
export function addMonths(iso, n) {
  const p = parseIso(iso);
  if (!p) return iso;
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return toIso(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/** 0 (Sunday) – 6 (Saturday). */
export function weekday(iso) {
  const p = parseIso(iso);
  return p ? new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() : 0;
}

/** Inclusive day count between two dates (same day -> 1). */
export function spanDays(startIso, endIso) {
  const a = parseIso(startIso);
  const b = parseIso(endIso);
  if (!a || !b) return 0;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000) + 1;
}

/** "Sunday, September 13, 2026" — for screen-reader labels. */
export function longLabel(iso) {
  const p = parseIso(iso);
  if (!p) return '';
  return `${WEEKDAY_LONG[weekday(iso)]}, ${MONTH_NAMES[p.m - 1]} ${p.d}, ${p.y}`;
}

export function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * Six fixed weeks (42 cells) for a month, so the popover never changes height
 * between months (no layout jump). Each cell: { iso, day, inMonth }.
 */
export function monthGrid(year, month, weekStartsOn = 0) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lead = (firstDow - weekStartsOn + 7) % 7;
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const ms = Date.UTC(year, month - 1, 1 - lead + i);
    const d = new Date(ms);
    cells.push({ iso: fromUtc(ms), day: d.getUTCDate(), inMonth: d.getUTCMonth() === month - 1 });
  }
  return cells;
}

/**
 * Today's civil date. With an IANA `timeZone` (the organization's business
 * zone) it is that zone's calendar day — never the browser's; without one it is
 * the browser's local calendar day (the app's existing fallback). Always
 * computed from the clock, never hardcoded.
 */
export function todayIso(timeZone, now = new Date()) {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch {
      /* unknown zone: fall through to the local calendar day */
    }
  }
  return toIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** Out of [min, max] or rejected by the caller's predicate. */
export function dayIsDisabled(iso, { min, max, isDateDisabled } = {}) {
  if (min && iso < min) return true;
  if (max && iso > max) return true;
  return Boolean(isDateDisabled?.(iso));
}

export function clampIso(iso, min, max) {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}
