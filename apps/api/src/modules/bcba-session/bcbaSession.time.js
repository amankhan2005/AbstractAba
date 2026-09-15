import { minutesBetween, computeLineAmount } from '../payroll/payroll.math.js';

/**
 * Pure timing + pay helpers for the BCBA session workflow. Deliberately thin:
 * the arithmetic that turns a worked interval into money is the EXISTING
 * payroll math (minutesBetween + computeLineAmount, HOURLY). This module is not
 * a second payroll engine — it is the glue that snapshots the derivation at the
 * moment of completion so it can be recorded (spec §13, §14).
 */

/** Whole worked minutes between two instants (server-authoritative). Throws on an inverted/invalid pair. */
export function workedMinutes(startedAt, endedAt) {
  return minutesBetween(startedAt, endedAt);
}

/**
 * Whole worked SECONDS across a session's timing intervals (onboarding §10).
 * Seconds, not minutes, because summing rounded minutes per interval would
 * inflate or deflate the total: three 9m40s intervals are 29 minutes, not 27
 * (3 × 9) and not 30 (3 × 10). We sum exact durations and round ONCE.
 *
 * Only CLOSED intervals count — a running interval is not yet worked time.
 */
export function intervalSeconds(intervals = []) {
  let total = 0;
  for (const iv of intervals ?? []) {
    if (!iv?.startedAt || !iv?.endedAt) continue;
    const ms = new Date(iv.endedAt).getTime() - new Date(iv.startedAt).getTime();
    if (Number.isFinite(ms) && ms > 0) total += ms / 1000;
  }
  return Math.round(total);
}

/**
 * THE authoritative worked minutes for a session, and the one place that
 * decision is made.
 *
 * Sessions that carry timing intervals are the SUM of their closed intervals,
 * so a clinician who worked 09:00–09:30, 11:00–12:00 and 14:00–15:00 is
 * credited 2h30m as ONE session. Sessions recorded before intervals existed
 * (and manual entries, which are a single block by construction) fall back to
 * the session's own verified clock, so historical payroll is unchanged.
 *
 * Never derives time from the appointment's scheduled duration.
 */
export function sessionWorkedMinutes(session) {
  const closed = (session?.intervals ?? []).filter((iv) => iv?.startedAt && iv?.endedAt);
  if (closed.length > 0) return Math.round(intervalSeconds(closed) / 60);
  // A RUNNING session has no end yet, and a legacy row may have an incoherent
  // pair. Both are "no worked time recorded" — never an exception: this is read
  // by the panel listing, which must render a running session's card rather
  // than fail the whole request. (minutesBetween is the strict payroll guard and
  // throws; it stays strict for the completion path that actually records pay.)
  const start = session?.clockInAt ?? session?.startedAt;
  const end = session?.clockOutAt ?? session?.endedAt;
  if (!start || !end) return 0;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : 0;
}

/**
 * Append a new work interval, or return the list unchanged when one is already
 * running (Start on an already-running session is idempotent, never a second
 * open interval).
 */
export function openInterval(intervals = [], at, staffProfileId = null) {
  const list = [...(intervals ?? [])];
  if (list.some((iv) => iv?.startedAt && !iv?.endedAt)) return list;
  list.push({ startedAt: at, endedAt: null, startedBy: staffProfileId, endedBy: null });
  return list;
}

/**
 * Close the running interval. Returns the list unchanged when nothing is
 * running, so a repeated Stop cannot rewrite an already-recorded interval
 * (onboarding §10: previous timing information is never overwritten).
 */
export function closeInterval(intervals = [], at, staffProfileId = null) {
  const list = [...(intervals ?? [])];
  const idx = list.findIndex((iv) => iv?.startedAt && !iv?.endedAt);
  if (idx === -1) return list;
  const iv = list[idx];
  if (new Date(at).getTime() <= new Date(iv.startedAt).getTime()) return list; // incoherent; leave it open
  list[idx] = { ...iv, endedAt: at, endedBy: staffProfileId };
  return list;
}

/**
 * Total worked SECONDS for a session: the sum of its closed timing intervals,
 * falling back to the verified clock for sessions recorded before intervals
 * existed. Seconds are kept so the completion screen can still show the exact
 * "1h 15m 23s" duration (§10) even when the total spans several intervals.
 */
export function sessionWorkedSeconds(session) {
  const closed = (session?.intervals ?? []).filter((iv) => iv?.startedAt && iv?.endedAt);
  if (closed.length > 0) return intervalSeconds(closed);
  const start = session?.clockInAt ?? session?.startedAt;
  const end = session?.clockOutAt ?? session?.endedAt;
  if (!start || !end) return 0;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

/**
 * Human duration "1h 15m 23s" from a whole-second total. Used where the
 * duration is a SUM across several intervals, so it cannot be derived from a
 * single start/end pair the way humanDuration does. Format is identical to
 * humanDuration's, so the completion screen reads the same for a one-interval
 * session as it always did.
 */
export function humanSeconds(totalSeconds) {
  let secs = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(secs / 3600); secs -= h * 3600;
  const m = Math.floor(secs / 60); secs -= m * 60;
  return `${h}h ${m}m ${secs}s`;
}

/** True when a work interval is currently running. */
export function hasRunningInterval(intervals = []) {
  return (intervals ?? []).some((iv) => iv?.startedAt && !iv?.endedAt);
}

/**
 * The start instant of the work period that is CURRENTLY RUNNING, or null when
 * nothing is running.
 *
 * THIS is what a live session timer must be anchored to. `session.startedAt` is
 * the start of the whole logical session and deliberately never moves, so after
 * a Stop and a restart it is hours behind the work actually in progress — a
 * clinician who worked 09:00-09:30, broke until 11:00 and restarted would see
 * 2:10 on the timer ten minutes into the second period. Anchoring on the open
 * interval gives the elapsed time of the period the clinician is actually in,
 * and it is server-persisted, so a refresh reconstructs it exactly.
 */
export function activePeriodStartedAt(session) {
  const open = (session?.intervals ?? []).find((iv) => iv?.startedAt && !iv?.endedAt);
  if (open) return open.startedAt;
  // Sessions recorded before work periods existed have no intervals: their
  // whole session IS the one running period, so the session start is correct.
  if ((session?.intervals ?? []).length === 0 && session?.startedAt && !session?.endedAt) {
    return session.startedAt;
  }
  return null;
}

/**
 * The payroll amount, in integer minor units (cents), for a worked interval at
 * an HOURLY rate. `hourlyRateMinor` is cents-per-hour. Returns null when no rate
 * is configured — the session still completes; the time record simply carries a
 * null amount for admin to resolve, exactly as the payroll run skips a staff
 * member with no rate today.
 */
export function payAmountMinor({ hourlyRateMinor, minutes }) {
  if (hourlyRateMinor === null || hourlyRateMinor === undefined) return null;
  return computeLineAmount({ rateType: 'HOURLY', rateAmount: hourlyRateMinor, minutes });
}

/** Dollars (as the staff port returns) → integer minor units (cents), or null. */
export function dollarsToMinor(dollars) {
  if (dollars === null || dollars === undefined) return null;
  const n = Number(dollars);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * Human duration "1h 15m 23s" from two instants, seconds included (§10). Pure
 * string formatting for the completion form; the authoritative number is
 * workedMinutes above.
 */
export function humanDuration(startedAt, endedAt) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '0h 0m 0s';
  let secs = Math.floor((end - start) / 1000);
  const h = Math.floor(secs / 3600); secs -= h * 3600;
  const m = Math.floor(secs / 60); secs -= m * 60;
  return `${h}h ${m}m ${secs}s`;
}
