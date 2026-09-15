import { AppError } from '../../common/errors/AppError.js';

/**
 * Server-side workflow state machine for supervision observations.
 *
 *   DRAFT     → SUBMITTED         (supervisor completes the write-up)
 *   SUBMITTED → SIGNED | DRAFT    (sign-off, or send back for correction)
 *   SIGNED    → (terminal)        immutable; corrections go through supersede
 *   SUPERSEDED→ (terminal)        replaced by a newer signed correction
 *
 * SIGNED and SUPERSEDED are immutable. A signed observation can only be
 * corrected by superseding it (files a new DRAFT that links back), mirroring the
 * clinical-documents supersede pattern.
 */
export const SUPERVISION_OBSERVATION_TRANSITIONS = Object.freeze({
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['SIGNED', 'DRAFT'],
  SIGNED: [],
  SUPERSEDED: [],
});

export function assertObservationTransition(from, to) {
  const allowed = SUPERVISION_OBSERVATION_TRANSITIONS[from];
  if (!allowed) throw AppError.conflict('SUPERVISION-409', `Unknown observation status: ${from}`);
  if (from === to) return;
  if (!allowed.includes(to)) {
    throw AppError.conflict('SUPERVISION-409', `Illegal observation transition ${from} -> ${to}`);
  }
}

/** True when an observation is in a mutable (editable) state. */
export function isObservationMutable(status) {
  return status === 'DRAFT';
}
