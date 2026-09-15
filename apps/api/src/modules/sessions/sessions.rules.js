import { sessionsError } from './sessions.errors.js';

/**
 * Pure, database-free rules for session capture. Keeping them here (mirroring
 * scheduling.rules.js) lets the measurement validation and the freeze/mutability
 * logic be unit-tested in isolation from persistence.
 */

// Measurement types whose reading is a single scalar carried in `value`.
export const SCALAR_MEASUREMENTS = ['FREQUENCY', 'DURATION', 'RATE', 'TRIALS_TO_CRITERION'];
// Measurement types whose reading is a ratio carried in numerator/denominator.
export const RATIO_MEASUREMENTS = ['PERCENT_CORRECT', 'INTERVAL'];

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Validate and normalise a captured measurement for a target's measurement type.
 * Scalar types require a non-negative `value`; ratio types require a
 * non-negative `numerator` no greater than a positive `denominator`. Returns the
 * normalised { value, numerator, denominator } (unused components null) or throws
 * INVALID_MEASUREMENT.
 */
export function validateMeasurement(measurementType, { value, numerator, denominator } = {}) {
  if (RATIO_MEASUREMENTS.includes(measurementType)) {
    if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator)) {
      throw sessionsError('INVALID_MEASUREMENT', { message: `${measurementType} requires numerator and denominator.` });
    }
    if (denominator <= 0 || numerator < 0 || numerator > denominator) {
      throw sessionsError('INVALID_MEASUREMENT', { message: `${measurementType} requires 0 <= numerator <= denominator and denominator > 0.` });
    }
    return { value: null, numerator, denominator };
  }
  if (SCALAR_MEASUREMENTS.includes(measurementType)) {
    if (!isFiniteNumber(value) || value < 0) {
      throw sessionsError('INVALID_MEASUREMENT', { message: `${measurementType} requires a non-negative value.` });
    }
    return { value, numerator: null, denominator: null };
  }
  throw sessionsError('INVALID_MEASUREMENT', { message: `Unknown measurement type ${measurementType}.` });
}

/** Refuse any mutation when the session is frozen (the immutability guard). */
export function assertMutable(status) {
  if (status === 'FROZEN') throw sessionsError('SESSION_FROZEN');
}

/**
 * Only a DRAFT or SUBMITTED session may be frozen; freezing an already-frozen
 * session is an invalid transition (freeze is terminal and idempotency is not
 * assumed, to keep the append-only clinical record honest).
 */
export function assertFreezable(status) {
  if (status !== 'DRAFT' && status !== 'SUBMITTED') throw sessionsError('INVALID_STATUS_TRANSITION');
}

/**
 * A PATCH may no longer change status AT ALL.
 *
 * This used to permit any DRAFT↔SUBMITTED move, which meant submission
 * bypassed the completeness check (blueprint 6.6) and the transition map: the
 * UI's own `canSubmit` boolean was the only thing standing between an
 * incomplete session and a BCBA's review queue. Every transition now has its
 * own endpoint that enforces what that transition actually requires.
 *
 * Kept as a guard rather than deleted so a caller that still sends a status —
 * an older client, a script — is refused loudly instead of having the field
 * silently ignored.
 */
export function assertPatchStatus(next) {
  if (next !== undefined) {
    throw sessionsError('INVALID_STATUS_TRANSITION');
  }
}
