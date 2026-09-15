/**
 * Canonical authorization unit arithmetic (spec Module 6 Parts 8/9/10).
 *
 * ONE rule, used everywhere (authorization, scheduling, sessions, billing):
 *
 *     1 UNIT = 15 MINUTES
 *
 * So 15m=1u, 30m=2u, 45m=3u, 60m=4u; and hours are DERIVED from units, never
 * stored as an independent, conflicting value (120 units = 30 hours).
 */
export const MINUTES_PER_UNIT = 15;

/** Minutes covered by a whole number of units. unitsToMinutes(4) === 60. */
export function unitsToMinutes(units) {
  const u = Number(units);
  if (!Number.isFinite(u) || u < 0) return 0;
  return u * MINUTES_PER_UNIT;
}

/** Exact units for a duration (may be fractional). minutesToUnits(30) === 2. */
export function minutesToUnits(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) return 0;
  return m / MINUTES_PER_UNIT;
}

/**
 * Billable units consumed by an appointment/session of the given duration.
 * At least one unit; rounded to the nearest whole unit (the burn-down is in
 * whole units). 15→1, 30→2, 45→3, 60→4.
 */
export function minutesToBillableUnits(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 1;
  return Math.max(1, Math.round(m / MINUTES_PER_UNIT));
}

/** Hours derived from units. unitsToHours(120) === 30. Two-decimal precision. */
export function unitsToHours(units) {
  const u = Number(units);
  if (!Number.isFinite(u) || u < 0) return 0;
  return Math.round((u * MINUTES_PER_UNIT) / 60 * 100) / 100;
}
