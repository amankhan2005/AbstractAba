import { AppError } from '../../common/errors/AppError.js';

/**
 * Payroll math. Pure and server-side; all money is integer minor units (cents),
 * no floating point for authoritative values. These functions are unit-tested.
 */
export function assertNonNegativeInt(value, field = 'amount') {
  if (!Number.isInteger(value) || value < 0) {
    throw AppError.validation(`${field} must be a non-negative integer (minor units).`);
  }
}

/** Sum time-entry minutes. Each entry must have positive integer minutes. */
export function sumMinutes(entries) {
  let total = 0;
  for (const e of entries) {
    if (!Number.isInteger(e.minutes) || e.minutes <= 0) {
      throw AppError.validation('Each time entry must have a positive integer number of minutes.');
    }
    total += e.minutes;
  }
  return total;
}

/**
 * Compute a single staff member's pay for a run, in minor units.
 *  - HOURLY:      round(rateAmount * minutes / 60)
 *  - PER_SESSION: rateAmount * sessionCount
 *  - SALARY:      rateAmount (flat per period)
 * Rounding is applied once, at the end, using integer math.
 */
export function computeLineAmount({ rateType, rateAmount, minutes = 0, sessionCount = 0 }) {
  assertNonNegativeInt(rateAmount, 'rateAmount');
  if (!Number.isInteger(minutes) || minutes < 0) throw AppError.validation('minutes must be a non-negative integer.');
  if (!Number.isInteger(sessionCount) || sessionCount < 0) throw AppError.validation('sessionCount must be a non-negative integer.');
  switch (rateType) {
    case 'HOURLY':
      return Math.round((rateAmount * minutes) / 60);
    case 'PER_SESSION':
      return rateAmount * sessionCount;
    case 'SALARY':
      return rateAmount;
    default:
      throw AppError.validation(`Unknown rate type: ${rateType}`);
  }
}

/** Sum payroll line amounts into a run total (minor units). */
export function sumLineAmounts(lines) {
  let total = 0;
  for (const l of lines) {
    assertNonNegativeInt(l.amount, 'line amount');
    total += l.amount;
  }
  return total;
}

/** Minutes between two instants, floored to whole minutes; throws if inverted. */
export function minutesBetween(startedAt, endedAt) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw AppError.validation('Invalid session times.');
  if (end <= start) throw AppError.validation('Session end must be after its start.');
  return Math.floor((end - start) / 60000);
}

/**
 * The staff member's applicable HOURLY rate (integer cents) for work done at
 * `at`: the Staff Profile PayRate in effect then (latest effectiveFrom ≤ at,
 * effectiveTo unset or ≥ at). When the first rate was recorded AFTER the work
 * (the usual case of a rate added once the staff member had started), that first
 * recorded rate applies. Returns null only when the staff member has no hourly
 * rate at all. Historical work is never re-priced at a later rate once an
 * earlier one existed.
 */
export function applicableHourlyRate(rates, at) {
  const hourly = (rates ?? []).filter((r) => (r.rateType ?? 'HOURLY') === 'HOURLY' && Number.isInteger(r.amount) && r.amount >= 0);
  if (!hourly.length) return null;
  const when = at ? new Date(at) : new Date();
  const sorted = [...hourly].sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom));
  const inEffect = sorted.find((r) => new Date(r.effectiveFrom) <= when && (!r.effectiveTo || new Date(r.effectiveTo) >= when));
  if (inEffect) return inEffect.amount;
  const earliest = sorted[sorted.length - 1];
  return new Date(earliest.effectiveFrom) > when ? earliest.amount : null;
}

/**
 * Split an amount (integer cents) across items in proportion to their minutes so
 * the parts sum EXACTLY to the amount (largest remainder).
 */
export function allocateCents(total, minutesList) {
  const sum = minutesList.reduce((t, m) => t + m, 0);
  if (sum === 0) return minutesList.map(() => 0);
  const exact = minutesList.map((m) => (total * m) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((t, p) => t + p, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) parts[order[k][1]] += 1;
  return parts;
}
