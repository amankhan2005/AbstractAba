/**
 * User-facing formatting helpers (Blueprint display conventions).
 *
 *   - Person names → each name component starts with one uppercase letter and
 *     the rest lowercase ("aMAN kHaN" → "Aman Khan"). Hyphenated and
 *     apostrophed parts are handled per sub-component ("mary-jane" →
 *     "Mary-Jane", "o'brien" → "O'Brien").
 *   - Dates → MM/DD/YYYY, using the value's local calendar day (parity with the
 *     previous toLocaleDateString display, format only changed).
 *
 * These never touch email addresses or identity keys — callers pass display
 * strings only.
 */

/**
 * Business-friendly label for a session / appointment lifecycle status.
 *
 * The database enum is never renamed (FROZEN stays FROZEN on disk and on the
 * API); this is the ONE place BCBA-facing surfaces turn that enum into words a
 * clinician reads. FROZEN — the approved, locked clinical record — reads
 * "Approved"; IN_PROGRESS reads "In progress"; DRAFT (a session not yet clocked
 * in) reads "Scheduled". Anything unmapped falls back to sentence case, so a new
 * enum like WAITING_FOR_REVIEW renders "Waiting for review" rather than a raw
 * token. Use this ONLY for session/appointment statuses — plan/goal/client
 * statuses keep their own labels (DRAFT there means "Draft", not "Scheduled").
 */
const SESSION_STATUS_LABELS = {
  DRAFT: 'Scheduled',
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  STOPPED: 'Stopped',
  SUBMITTED: 'Submitted',
  RETURNED: 'Returned',
  FROZEN: 'Approved',
  APPROVED: 'Approved',
  COMPLETED: 'Completed',
  AMENDED: 'Amended',
  CANCELLED: 'Cancelled',
  CANCELED: 'Cancelled',
  NO_SHOW: 'No show',
};
export function statusLabel(status) {
  if (!status) return '—';
  const key = String(status).toUpperCase();
  if (SESSION_STATUS_LABELS[key]) return SESSION_STATUS_LABELS[key];
  const s = key.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Status text for a session row/detail. A MANUAL session (manual time entry) is
 * completed work recorded by the clinician — it never went through review, so
 * it reads "Completed" rather than the review-flow "Approved". Every other
 * session uses statusLabel unchanged.
 */
export function sessionStatusText(session) {
  if (session?.source === 'MANUAL' && (session.status === 'FROZEN' || session.status === 'AMENDED')) return 'Completed';
  return statusLabel(session?.status);
}

/**
 * Display label for a workflow/status enum value: underscores become spaces and
 * the value is sentence-cased — ACTIVE → "Active", ON_HOLD → "On hold",
 * NOT_SENT / "not sent" → "Not sent", HOLD → "Hold". Stored values are never
 * changed; this only formats them for display. Empty input → "".
 */
export function formatStatusLabel(value) {
  if (value == null) return '';
  const text = String(value).replace(/_/g, ' ').trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/** Title-case a single person-name component, splitting on - and '. */
function titleCaseWord(word) {
  return word.replace(/[^\s]+/g, (run) =>
    run
      .split(/([-'])/)
      .map((part) =>
        part === '-' || part === "'"
          ? part
          : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
      )
      .join(''),
  );
}

/**
 * Format a person's display name: first letter of each component uppercase,
 * remainder lowercase. Returns '' for empty/nullish input. Does not reorder or
 * alter spacing beyond collapsing runs.
 */
export function formatPersonName(name) {
  if (name == null) return '';
  const str = String(name).trim();
  if (!str) return '';
  return str.split(/\s+/).map(titleCaseWord).join(' ');
}

/**
 * The display FIRST name: the first word of a persisted first name, formatted
 * with the canonical person-name casing. "test1 john" → "Test1", "ANA" → "Ana".
 * Display-only — stored names are never rewritten. Returns '' when empty.
 */
export function formatFirstName(firstName) {
  if (firstName == null) return '';
  const first = String(firstName).trim().split(/\s+/)[0] ?? '';
  return first ? formatPersonName(first) : '';
}

/**
 * Join and format first/last (and optional middle) into a single display name.
 */
export function formatFullName({ firstName, middleName, lastName } = {}) {
  return [firstName, middleName, lastName]
    .filter((p) => p != null && String(p).trim() !== '')
    .map((p) => formatPersonName(p))
    .join(' ');
}

/**
 * Format a date value as MM/DD/YYYY. Accepts a Date, an ISO string, or an epoch
 * number. Returns '' when the value is nullish or unparseable (never
 * "undefined"/"NaN"/"Invalid Date").
 */
export function formatDate(value, timeZone) {
  if (value == null || value === '') return '';
  // Date-only values (a calendar date such as a DOB) must never be shifted by
  // timezone: `new Date('2005-08-27')` is UTC midnight, which renders as the
  // PREVIOUS day west of UTC. Read the calendar parts straight from the string.
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // An INSTANT with an IANA `timeZone` is read in that zone (the organization's
  // business calendar), never the browser's.
  if (timeZone) {
    return new Intl.DateTimeFormat('en-US', { timeZone, month: '2-digit', day: '2-digit', year: 'numeric' }).format(d);
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Today's calendar date as a YYYY-MM-DD string, read from LOCAL calendar parts
 * (never `toISOString()`, which is UTC and shifts the day west of UTC). This is
 * the internal value the shared date picker (`DateInput`) takes; it DISPLAYS it
 * as MM/DD/YYYY. Dynamically generated every call, so "today" is never
 * hardcoded.
 */
export function todayLocalISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * The signed-in organization's IANA timezone, set by the auth store whenever the
 * principal changes. formatTime / formatDateTime render an INSTANT in this zone
 * when a caller passes no zone, so a clock time (clocked in/out, scheduled start)
 * never silently falls back to the BROWSER's timezone. Null for platform
 * operators or before sign-in, which keeps the plain local render.
 */
let defaultTimeZone = null;
export function setDefaultTimeZone(timeZone) {
  defaultTimeZone = typeof timeZone === 'string' && timeZone ? timeZone : null;
}

/** MM/DD/YYYY date + USA time (e.g. "09/09/2026 5:30 PM"). Optional IANA
 *  `timeZone` renders in that zone; without one, the organization's timezone. */
export function formatDateTime(value, timeZone) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const zone = timeZone || defaultTimeZone || undefined;
  const date = formatDate(d, zone);
  return `${date} ${formatTime(d, zone)}`;
}

/**
 * USA-friendly time: "5:30 PM", "9:05 AM" — `hour: 'numeric'` (no leading zero),
 * `minute: '2-digit'`, AM/PM, no seconds. Optional IANA `timeZone`; without
 * one the organization's timezone (setDefaultTimeZone) is used.
 */
export function formatTime(value, timeZone) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const zone = timeZone || defaultTimeZone;
  return new Intl.DateTimeFormat('en-US', {
    ...(zone ? { timeZone: zone } : {}),
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}

/**
 * DISPLAY-ONLY worked-time format (spec §16): "3h 03m" — hours and zero-padded
 * minutes, no seconds, never decimal hours. 183 min → "3h 03m"; 75 → "1h 15m";
 * 45 → "45m"; 150 → "2h 30m"; 0 → "0m". Internally everything stays integer
 * minutes; this string is never multiplied by a rate or parsed back. Returns ''
 * for nullish/negative-invalid input.
 */
export function formatDuration(minutes) {
  if (minutes == null || minutes === '') return '';
  const total = Math.round(Number(minutes));
  if (!Number.isFinite(total) || total < 0) return '';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * USD money from INTEGER CENTS (the app's storage): 3000 → "$30.00", 150 → "$1.50".
 * Only a "$" symbol — never a literal "USD". Storage/calculation stay in cents.
 */
export function formatMoney(cents) {
  if (cents == null || cents === '' || !Number.isFinite(Number(cents))) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents) / 100);
}
