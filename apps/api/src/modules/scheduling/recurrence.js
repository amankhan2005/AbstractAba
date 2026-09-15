import { AppError } from '../../common/errors/AppError.js';
import { RECURRENCE_FREQUENCY } from '../../models/enums.js';

/**
 * Pure recurrence expansion. Given a small recurrence rule, produce the list of
 * occurrence start/end Date pairs. No I/O, no database — fully unit-tested.
 *
 * Rule shape:
 *   { frequency: 'DAILY'|'WEEKLY', interval, byWeekday?, startDate, untilDate?,
 *     count?, startMinute, endMinute }
 *
 * Bounds: expansion stops at whichever of untilDate / count is reached first; a
 * hard safety cap prevents unbounded generation. Times are applied as UTC
 * minute-of-day offsets from each occurrence's date so results are deterministic
 * regardless of server timezone.
 */

const MAX_OCCURRENCES = 366; // safety cap (≈ one year of daily)
const DAY_MS = 24 * 60 * 60 * 1000;

/** Validate the rule shape and return a normalized copy. */
export function validateRecurrenceRule(rule) {
  if (!RECURRENCE_FREQUENCY.includes(rule.frequency)) {
    throw AppError.validation('Unsupported recurrence frequency.');
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 52) {
    throw AppError.validation('Recurrence interval must be between 1 and 52.');
  }
  if (!(rule.startDate instanceof Date) || Number.isNaN(rule.startDate.getTime())) {
    throw AppError.validation('A valid start date is required.');
  }
  if (rule.untilDate == null && rule.count == null) {
    throw AppError.validation('A recurrence must be bounded by an end date or an occurrence count.');
  }
  if (rule.count != null && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > MAX_OCCURRENCES)) {
    throw AppError.validation(`Occurrence count must be between 1 and ${MAX_OCCURRENCES}.`);
  }
  if (rule.untilDate != null && !(rule.untilDate instanceof Date)) {
    throw AppError.validation('until date must be a valid date.');
  }
  if (rule.untilDate != null && rule.untilDate < rule.startDate) {
    throw AppError.validation('until date cannot be before the start date.');
  }
  if (!Number.isInteger(rule.startMinute) || rule.startMinute < 0 || rule.startMinute > 1439) {
    throw AppError.validation('startMinute must be between 0 and 1439.');
  }
  if (!Number.isInteger(rule.endMinute) || rule.endMinute <= rule.startMinute || rule.endMinute > 1440) {
    throw AppError.validation('endMinute must be after startMinute and at most 1440.');
  }
  if (rule.frequency === 'WEEKLY' && Array.isArray(rule.byWeekday)) {
    for (const d of rule.byWeekday) {
      if (!Number.isInteger(d) || d < 0 || d > 6) throw AppError.validation('byWeekday values must be 0–6 (Sun–Sat).');
    }
  }
  return rule;
}

/** UTC date at midnight for a given Date (strips the time component). */
function atUtcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Expand a rule into concrete occurrences. Returns
 * [{ startAt: Date, endAt: Date }] in chronological order.
 *
 * `afterDate` (optional) skips occurrences on/before that date — used to
 * materialize only future occurrences when extending or re-materializing.
 */
export function expandOccurrences(rule, { afterDate = null } = {}) {
  validateRecurrenceRule(rule);
  const { frequency, interval, startMinute, endMinute } = rule;
  const weekdays = frequency === 'WEEKLY' && rule.byWeekday?.length ? new Set(rule.byWeekday) : null;
  const until = rule.untilDate ? atUtcMidnight(rule.untilDate) : null;
  const maxCount = rule.count ?? MAX_OCCURRENCES;
  const startMidnight = atUtcMidnight(rule.startDate);

  // 1) Generate the full series bounded by count/until (independent of afterDate),
  //    so the series' identity/size is stable regardless of when we materialize.
  const occurrences = [];
  let step = 0;
  while (occurrences.length < maxCount && occurrences.length < MAX_OCCURRENCES) {
    if (step > MAX_OCCURRENCES * 8) break; // safety against unsatisfiable rules
    if (frequency === 'DAILY') {
      const day = new Date(startMidnight.getTime() + step * interval * DAY_MS);
      if (until && day > until) break;
      occurrences.push(materializeWindow(day, startMinute, endMinute));
    } else {
      // WEEKLY: advance week-by-week; within each active week emit matching weekdays.
      const weekStart = new Date(startMidnight.getTime() + step * interval * 7 * DAY_MS);
      if (until && weekStart > until) break;
      const days = weekdays ? [...weekdays].sort((a, b) => a - b) : [startMidnight.getUTCDay()];
      let addedFromThisWeek = false;
      for (const wd of days) {
        if (occurrences.length >= maxCount) break;
        const offset = (wd - weekStart.getUTCDay() + 7) % 7;
        const dday = new Date(weekStart.getTime() + offset * DAY_MS);
        if (dday < startMidnight) continue;
        if (until && dday > until) continue;
        occurrences.push(materializeWindow(dday, startMinute, endMinute));
        addedFromThisWeek = true;
      }
      if (until && weekStart > until && !addedFromThisWeek) break;
    }
    step += 1;
  }

  occurrences.sort((a, b) => a.startAt - b.startAt);
  const full = occurrences.slice(0, maxCount);

  // 2) Filter to future occurrences if requested (does not change series size).
  if (!afterDate) return full;
  return full.filter((o) => o.startAt > afterDate);
}

function materializeWindow(dayUtcMidnight, startMinute, endMinute) {
  const startAt = new Date(dayUtcMidnight.getTime() + startMinute * 60 * 1000);
  const endAt = new Date(dayUtcMidnight.getTime() + endMinute * 60 * 1000);
  return { startAt, endAt };
}
