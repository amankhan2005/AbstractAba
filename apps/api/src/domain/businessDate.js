/**
 * ---------------------------------------------------------------------------
 * THE BUSINESS DATE AUTHORITY.
 *
 * Before this module the platform had THREE different answers to "what day is
 * this appointment on?":
 *
 *   1. scheduling/booking.js composed 'YYYY-MM-DD' + 'HH:MM' as a UTC instant
 *      ("no bespoke timezone system") — so a New York clinic's 09/12 booking
 *      was persisted as 2026-09-12T00:00:00Z, which IS 09/11 in New York;
 *   2. bcba-session (the Start gate) and payroll/payroll.periods correctly used
 *      the ORGANIZATION timezone via Intl — and therefore disagreed with what
 *      booking had just written ("Not available for today");
 *   3. the web calendar bucketed appointments with getFullYear/getMonth/getDate
 *      — the BROWSER's timezone — and therefore disagreed with both (an evening
 *      time entered from an IST browser rendered on September 13).
 *
 * There is now exactly one answer, and it lives here. The organization timezone
 * is the business authority (onboarding §19); browser, server and UTC dates are
 * never used to decide a business date.
 *
 * THE ONE RULE every layer applies:
 *
 *   An appointment occupies the half-open instant interval [startAt, endAt).
 *   Its business days are the organization-timezone civil days that interval
 *   touches, i.e. civilDay(startAt) .. civilDay(endAt - 1ms).
 *
 * That single rule makes an inclusive end date, a single-day appointment that
 * stays valid all day, and a timed appointment all fall out of the same
 * arithmetic — no special cases, and no off-by-one at either boundary.
 * ---------------------------------------------------------------------------
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' (a calendar date, with no time and no zone). */
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 'HH:MM', 24-hour clock. */
export const CLOCK_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// An IANA zone identifier: "UTC" or Area/Location[/Sub], each segment starting
// with an uppercase letter (America/New_York, America/Argentina/Buenos_Aires,
// Etc/GMT+5). Rejects offsets ("+05:00"), legacy abbreviations ("EST") and
// free text — an organization's business timezone must be a named zone so
// daylight saving is applied by the tz database, never a fixed offset.
const IANA_ZONE_RE = /^(?:UTC|[A-Z][A-Za-z_-]*(?:\/[A-Z][A-Za-z0-9_+-]*)+)$/;

/**
 * Whether `value` is an IANA timezone this runtime can apply. The server
 * validates an organization's timezone with this before persisting it, so every
 * business-date calculation below receives a zone Intl can resolve.
 */
export function isValidTimeZone(value) {
  if (typeof value !== 'string' || !IANA_ZONE_RE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock calendar parts of an instant in a given IANA timezone. */
export function zonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    weekday: 'short', hour12: false,
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl emits "24" for midnight under hour12:false in some engines; fold to 0.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY[parts.weekday],
  };
}

/**
 * The UTC instant corresponding to local midnight (00:00:00) of Y-M-D in the
 * given timezone. DST-correct: it measures the zone's offset AT that wall clock
 * and corrects the naive guess by it (the standard two-step method).
 */
export function zonedMidnightToUtc(year, month, day, timeZone) {
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const p = zonedParts(new Date(naiveUtc), timeZone);
  const asZoned = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = asZoned - naiveUtc; // ms the zone is ahead of UTC at that wall clock
  return new Date(naiveUtc - offset);
}

/** Parse 'YYYY-MM-DD' into {year, month, day}, or null when it is not a calendar date. */
export function parseCivilDate(value) {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value.trim())) return null;
  const [y, m, d] = value.trim().split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible calendar dates (02/31 etc.) by round-tripping through UTC.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { year: y, month: m, day: d };
}

/** Minutes past midnight for an 'HH:MM' clock time, or null. */
export function parseClockMinutes(value) {
  if (typeof value !== 'string' || !CLOCK_TIME_RE.test(value.trim())) return null;
  const [h, m] = value.trim().split(':').map(Number);
  return h * 60 + m;
}

/**
 * Comparable civil day number (YYYYMMDD) for an instant in a timezone. Used to
 * compare business days without any UTC drift.
 */
export function civilDayNumber(value, timeZone) {
  const p = zonedParts(new Date(value), timeZone);
  return p.year * 10000 + p.month * 100 + p.day;
}

/** The civil date string 'YYYY-MM-DD' for an instant in a timezone. */
export function civilDateString(value, timeZone) {
  const p = zonedParts(new Date(value), timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The half-open instant interval covering a business date RANGE, with the end
 * date INCLUSIVE (onboarding §7: 09/12 → 09/14 means 09/12, 09/13 and 09/14 are
 * all scheduled, and 09/15 is expired).
 *
 * Returns { startAt, endAt } where endAt is the EXCLUSIVE upper bound — org
 * midnight at the start of the day AFTER endDate. Storing the exclusive bound
 * (rather than 23:59:59) is what makes "expires when the business date becomes
 * 09/15" exact rather than approximately exact.
 */
export function businessDayRange(startDate, endDate, timeZone) {
  const s = parseCivilDate(startDate);
  if (!s) return null;
  const e = parseCivilDate(endDate) ?? s;
  const startAt = zonedMidnightToUtc(s.year, s.month, s.day, timeZone);
  // Day AFTER the (inclusive) end date, computed on the civil calendar so a
  // month/year rollover is handled by the Date arithmetic, not by us.
  const afterEnd = new Date(Date.UTC(e.year, e.month - 1, e.day) + DAY_MS);
  const endAt = zonedMidnightToUtc(
    afterEnd.getUTCFullYear(), afterEnd.getUTCMonth() + 1, afterEnd.getUTCDate(), timeZone,
  );
  if (endAt.getTime() <= startAt.getTime()) return null;
  return { startAt, endAt };
}

/**
 * A specific wall-clock instant on a business date, in the org timezone.
 * `minutes` is minutes past midnight (so 19:00 → 1140).
 */
export function businessInstant(date, minutes, timeZone) {
  const d = parseCivilDate(date);
  if (!d) return null;
  const midnight = zonedMidnightToUtc(d.year, d.month, d.day, timeZone);
  return new Date(midnight.getTime() + (minutes ?? 0) * 60000);
}

/**
 * The LAST business day an appointment touches, as a civil day number. This is
 * the inclusive counterpart of the exclusive `endAt` bound: an appointment
 * ending exactly at org midnight belongs to the day BEFORE that midnight, not
 * to the new day.
 *
 * Applying this consistently is what removes the off-by-one at the end of the
 * range for both date-only appointments (which end at exclusive midnight) and
 * timed appointments (which do not).
 */
export function lastCoveredDayNumber(startAt, endAt, timeZone) {
  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : start;
  const inclusiveEnd = end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : start;
  return civilDayNumber(inclusiveEnd, timeZone);
}

/**
 * True when `now`'s CALENDAR business day is one of the appointment's covered
 * days. Calendar coverage only (what day an appointment appears on) — it is NOT
 * the session start gate; that is `startEligibility` (a 24-hour window).
 */
export function coversBusinessDay(startAt, endAt, timeZone, now = new Date()) {
  if (!startAt) return true; // an undated appointment is not day-gated
  const today = civilDayNumber(now, timeZone);
  const first = civilDayNumber(startAt, timeZone);
  const last = lastCoveredDayNumber(startAt, endAt, timeZone);
  return today >= first && today <= last;
}

/** A session start window is EXACTLY 24 hours of elapsed time. */
export const START_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * UTC instant for a wall-clock time on a civil date in an IANA zone. Same
 * two-step offset correction as zonedMidnightToUtc, generalised to any clock
 * time, so a non-midnight wall time is DST-correct too.
 */
export function zonedWallTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetAt = (instantMs) => {
    const p = zonedParts(new Date(instantMs), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMs;
  };
  const guess = naive - offsetAt(naive);
  return new Date(naive - offsetAt(guess));
}

function addCivilDays(dateString, days) {
  const d = parseCivilDate(dateString);
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/**
 * ---------------------------------------------------------------------------
 * THE SESSION START ELIGIBILITY RULE — the ONE authority for "can a BCBA/RBT
 * start (or resume, or clock in to) this appointment right now?". The web
 * client mirrors it in apps/web/src/lib/businessDate.js.
 *
 * It is TIMESTAMP-based, never "appointment date === today":
 *
 *   Each scheduled business date D opens a start window of exactly 24 hours
 *   (START_WINDOW_MS) of elapsed time:
 *
 *     windowStart(D) = the appointment's scheduled start on D
 *       · timed appointment (timeSet !== false): its scheduled wall-clock
 *         start time on D, in the org timezone (for the first date this is
 *         exactly the stored startAt);
 *       · date-only appointment (timeSet === false): the existing business-date
 *         convention — org-timezone midnight at the start of D (what booking
 *         already stores as startAt; see businessDayRange).
 *     windowEnd(D)   = windowStart(D) + 24h            (EXCLUSIVE)
 *
 *   A 09/12 10:00 AM appointment is startable from 09/12 10:00:00 AM through
 *   09/13 09:59:59.999 AM and EXPIRED at 09/13 10:00 AM (org time). Because it
 *   is elapsed time, a window that crosses a DST change still lasts 24 real
 *   hours (so its closing wall-clock time moves by the hour that changed).
 *
 *   A multi-day appointment (09/12 → 09/14) has one window per scheduled date;
 *   the appointment is startable while ANY of them is open, is UPCOMING before
 *   the first opens (or in a gap between two), and EXPIRED once the LAST closes.
 *
 * Returns { status: 'UPCOMING' | 'AVAILABLE' | 'EXPIRED', businessDate,
 * windowStart, windowEnd } — the window being described is the open one, the
 * next one (UPCOMING), or the last one (EXPIRED). An undated appointment is not
 * gated. Pure: `now` is the SERVER clock at every call site — never a
 * client-supplied time.
 *
 * EACH SCHEDULED DATE IS ITS OWN OCCURRENCE. With `{ businessDate }` the
 * result describes ONLY that date's window, never another date in the range:
 * on 09/13 a 09/12 → 09/30 appointment's 09/12 occurrence is EXPIRED, its 09/13
 * occurrence AVAILABLE and its 09/14 occurrence UPCOMING. This is what a
 * session already bound to a date (see sessionBusinessDate) is judged by, so
 * work begun on 09/12 can never be resumed under 09/13's window.
 * ---------------------------------------------------------------------------
 */
export function startEligibility({ startAt, endAt, timeSet } = {}, timeZone, now = new Date(), { businessDate: occurrence = null } = {}) {
  if (!startAt) return { status: 'AVAILABLE', businessDate: null, windowStart: null, windowEnd: null };
  const zone = timeZone || 'UTC';
  const start = new Date(startAt);
  const firstDate = civilDateString(start, zone);
  const lastDate = lastBusinessDateString(start, endAt ?? start, zone);
  const clock = zonedParts(start, zone);

  const windowFor = (date) => {
    const d = parseCivilDate(date);
    let open;
    if (timeSet === false) open = zonedMidnightToUtc(d.year, d.month, d.day, zone);
    else if (date === firstDate) open = start;
    else open = zonedWallTimeToUtc(d.year, d.month, d.day, clock.hour, clock.minute, clock.second, zone);
    return { businessDate: date, windowStart: open, windowEnd: new Date(open.getTime() + START_WINDOW_MS) };
  };

  const t = new Date(now).getTime();

  if (occurrence) {
    // One specific scheduled date, judged only by its own 24-hour window.
    const w = windowFor(occurrence);
    if (t < w.windowStart.getTime()) return { status: 'UPCOMING', ...w };
    if (t >= w.windowEnd.getTime()) return { status: 'EXPIRED', ...w };
    return { status: 'AVAILABLE', ...w };
  }

  const first = windowFor(firstDate);
  if (t < first.windowStart.getTime()) return { status: 'UPCOMING', ...first };
  const last = windowFor(lastDate);
  if (t >= last.windowEnd.getTime()) return { status: 'EXPIRED', ...last };

  // Inside the overall span. Each window is 24h long, so only the windows of
  // the two previous civil dates, today and tomorrow can be open or next.
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

/**
 * The scheduled occurrence (business date) a session belongs to: the date whose
 * start window was open when work on the session FIRST began (its first timing
 * interval, else its clock-in, else — for a non-draft legacy row — startedAt).
 * A DRAFT that never started any work is not bound to a date and returns null,
 * so it is judged by whichever occurrence is open now.
 */
export function sessionBusinessDate(appointment, session, timeZone) {
  if (!appointment?.startAt || !session) return null;
  const firstInterval = (session.intervals ?? []).find((iv) => iv?.startedAt);
  const began = firstInterval?.startedAt
    ?? session.clockInAt
    ?? (session.status && session.status !== 'DRAFT' ? session.startedAt : null);
  if (!began) return null;
  const at = startEligibility(appointment, timeZone, began);
  return at.status === 'AVAILABLE' ? at.businessDate : civilDateString(began, timeZone || 'UTC');
}

/** "09/13/2026 10:00 AM" for an instant in the org timezone (user-facing). */
export function formatBusinessDateTime(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC', month: '2-digit', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/**
 * The refusal the start gates return for a non-AVAILABLE eligibility, so the
 * BCBA/RBT panel and the lifecycle clock-in say exactly the same thing.
 */
export function describeStartIneligibility(eligibility, timeZone, { verb = 'start a session', sessionBound = false } = {}) {
  const tz = timeZone || 'UTC';
  const opens = formatBusinessDateTime(eligibility.windowStart, tz);
  const closed = formatBusinessDateTime(eligibility.windowEnd, tz);
  const d = eligibility.businessDate;
  const dateText = d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '';
  let message;
  if (sessionBound && eligibility.status === 'EXPIRED') {
    message = `This session belongs to ${dateText}, and that date\u2019s start window closed at ${closed}. Finish this session before starting a new one.`;
  } else if (eligibility.status === 'EXPIRED') {
    message = `This appointment expired. Its 24-hour start window closed at ${closed}, so you can no longer ${verb}.`;
  } else {
    message = `This appointment isn\u2019t open yet. You can ${verb} from ${opens}.`;
  }
  return {
    message,
    details: {
      startStatus: eligibility.status,
      businessDate: eligibility.businessDate,
      windowStart: eligibility.windowStart,
      windowEnd: eligibility.windowEnd,
      timeZone: tz,
    },
  };
}

/** The appointment's last scheduled business date as 'YYYY-MM-DD' (inclusive). */
export function lastBusinessDateString(startAt, endAt, timeZone) {
  if (!startAt) return null;
  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : start;
  const inclusiveEnd = end.getTime() > start.getTime() ? new Date(end.getTime() - 1) : start;
  return civilDateString(inclusiveEnd, timeZone);
}

/**
 * Every business date an appointment covers, as 'YYYY-MM-DD' strings, inclusive
 * of both ends. This is what the calendar marks: a multi-day appointment
 * appears on EVERY scheduled date, not only on its first day (onboarding §7).
 * Defensively capped so a corrupt range cannot spin.
 */
export function coveredBusinessDates(startAt, endAt, timeZone, maxDays = 400) {
  if (!startAt) return [];
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return [];
  const firstParts = zonedParts(start, timeZone);
  const lastDayNumber = lastCoveredDayNumber(startAt, endAt, timeZone);
  const out = [];
  // Walk civil days forward from the first covered day using UTC calendar
  // arithmetic on the civil parts (never on the instant, which would drift
  // across a DST boundary).
  let cursor = Date.UTC(firstParts.year, firstParts.month - 1, firstParts.day);
  for (let i = 0; i < maxDays; i += 1) {
    const d = new Date(cursor);
    const num = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    if (num > lastDayNumber) break;
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
    cursor += DAY_MS;
  }
  return out;
}

export { DAY_MS };
