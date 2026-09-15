/**
 * Presentation helpers for user-facing rendered content (currently the email
 * renderer). These normalize DISPLAY only — never email addresses, identity
 * keys, or stored values.
 *
 *   - Person names → each component's first letter uppercase, rest lowercase
 *     ("aMAN kHaN" → "Aman Khan"); hyphen/apostrophe sub-parts handled.
 *   - Dates → MM/DD/YYYY.
 *
 * Mirrors apps/web/src/lib/format.js so the server renders names/dates exactly
 * as the web app displays them.
 */

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

/** Title-case a person's display name. Returns '' for nullish/empty input. */
export function formatPersonName(name) {
  if (name == null) return '';
  const str = String(name).trim();
  if (!str) return '';
  return str.split(/\s+/).map(titleCaseWord).join(' ');
}

/** Format a date value as MM/DD/YYYY. Returns '' for nullish/unparseable input. */
export function formatDate(value) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Serialize a CALENDAR date (DOB, authorization start/end) as a timezone-safe
 * date-only string `YYYY-MM-DD`. Calendar dates are stored at UTC midnight, so
 * reading the UTC parts yields the intended day in every timezone — unlike
 * emitting a full ISO datetime, which the client would shift a day west of UTC
 * (e.g. `2026-08-01T00:00:00.000Z` renders as 07/31/2026 in America/New_York).
 *
 * This is the SINGLE canonical calendar-date serializer for the API: DOB (via
 * toClient) and ABA/FBA authorization dates (via toServiceAuth and the
 * scheduling authAdapter) all go through it, so a date-only value never leaks to
 * the UI as a shiftable datetime. Null/invalid -> null (the UI renders a
 * placeholder, never "Invalid Date").
 */
export function toDateOnly(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
