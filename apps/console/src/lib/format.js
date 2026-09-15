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
export function formatDate(value) {
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
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  return `${mm}/${dd}/${yyyy}`;
}

/** MM/DD/YYYY date + local time — for audit/event rows that showed a datetime. */
export function formatDateTime(value) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${formatDate(d)} ${time}`;
}
