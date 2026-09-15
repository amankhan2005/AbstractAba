import { orgError } from './organization.errors.js';

/**
 * The organization lifecycle state machine (Module 1 §3.2), ported from the
 * original. Encoded as data so the permitted graph is readable and exhaustively
 * testable. A transition not listed here cannot happen — the gate that stops an
 * organization reaching ACTIVE (where PHI may be stored) without its agreement.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  PROVISIONING: ['PENDING_AGREEMENT'],
  PENDING_AGREEMENT: ['ACTIVE', 'OFFBOARDING'],
  ACTIVE: ['SUSPENDED', 'OFFBOARDING'],
  SUSPENDED: ['ACTIVE', 'OFFBOARDING'],
  OFFBOARDING: ['DESTROYED'],
  DESTROYED: [],
});

const SIGN_IN_PERMITTED = ['ACTIVE', 'PENDING_AGREEMENT', 'SUSPENDED', 'OFFBOARDING'];

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function allowedTransitionsFrom(state) {
  return ALLOWED_TRANSITIONS[state] ?? [];
}

/** Only ACTIVE may store clinical data — the gate behind Module 1 FR-2.2. */
export function mayStoreClinicalData(state) {
  return state === 'ACTIVE';
}

export function maySignIn(state) {
  return SIGN_IN_PERMITTED.includes(state);
}

/**
 * Validates a proposed transition, throwing the precise error when disallowed.
 * Guards are checked most-fundamental first.
 */
export function assertTransitionAllowed({ organization, target, destruction }) {
  if (!canTransition(organization.state, target)) {
    throw orgError('ILLEGAL_STATE_TRANSITION', { context: { from: organization.state, to: target } });
  }

  // Activation requires an executed business associate agreement (FR-2.1).
  if (target === 'ACTIVE' && organization.state === 'PENDING_AGREEMENT') {
    if (organization.agreementId === null || organization.agreementId === undefined) {
      throw orgError('AGREEMENT_REQUIRED');
    }
  }

  if (target === 'DESTROYED') {
    if (!destruction) {
      throw orgError('DESTRUCTION_PRECONDITIONS_UNMET', {
        context: { reason: 'destruction details were not supplied' },
      });
    }
    // Separation of duties: requester may not approve their own destruction (FR-6.3).
    if (destruction.requestedByUserId === destruction.approvedByUserId) {
      throw orgError('SAME_ACTOR_APPROVAL');
    }
    if (!destruction.exportCompleted || !destruction.graceElapsed) {
      throw orgError('DESTRUCTION_PRECONDITIONS_UNMET', {
        context: { exportCompleted: destruction.exportCompleted, graceElapsed: destruction.graceElapsed },
      });
    }
  }
}
