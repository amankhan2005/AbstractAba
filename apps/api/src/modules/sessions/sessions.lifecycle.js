import { sessionsError } from './sessions.errors.js';

/**
 * ---------------------------------------------------------------------------
 * SESSION LIFECYCLE — blueprint Figure 6.2 and §9.4.
 *
 *   Scheduled ─▶ In progress ─▶ Captured ─▶ Submitted ─▶ Approved ─▶ Amended
 *                     │                          │
 *                     └──▶ Cancelled             └──▶ Returned ──┐
 *                                                    ▲           │
 *                                                    └───────────┘
 *
 * "Approval is the boundary between a mutable working record and the immutable
 * fact that billing and payroll derive from." (Figure 6.2 caption)
 *
 * BEFORE: the enum held DRAFT, SUBMITTED and FROZEN only. A BCBA could approve
 * or do nothing — there was no way to return a session with a comment, which
 * §9.4 step 5 and §6.6 ("approve · return with comment") both require, and no
 * way to record that a session did not happen. The review queue therefore had
 * one of its two documented actions missing, and cancellation was modelled as a
 * soft delete, which loses the reason taxonomy §6.4 depends on.
 *
 * WHO may perform each transition is deliberately expressed as a permission +
 * relationship rule rather than a role name, because the blueprint is explicit
 * that a role is "a named bundle of permissions — never a place in the
 * navigation" (§4.1), and because multi-role users are the normal case (§4.12).
 * ---------------------------------------------------------------------------
 */

/** Legal transitions. Anything absent here is refused by the backend. */
export const SESSION_TRANSITIONS = Object.freeze({
  DRAFT: ['IN_PROGRESS', 'SUBMITTED', 'CANCELLED'],
  IN_PROGRESS: ['DRAFT', 'SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['FROZEN', 'RETURNED'],
  RETURNED: ['DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'CANCELLED'],
  // Approval is terminal for the record itself. The ONLY forward move is to
  // AMENDED, and that is performed by creating an attributed amendment — never
  // by editing this row (§6.6 Amendments, BR-CN-3).
  FROZEN: ['AMENDED'],
  AMENDED: [],
  CANCELLED: [],
});

/** States in which the working record may still be edited. */
export const MUTABLE_STATES = Object.freeze(['DRAFT', 'IN_PROGRESS', 'RETURNED']);

/** States that are immutable facts downstream modules derive from. */
export const IMMUTABLE_STATES = Object.freeze(['FROZEN', 'AMENDED', 'CANCELLED']);

/**
 * Transitions requiring a stated reason. The blueprint attaches a reason to
 * each of these explicitly: return carries "a comment that reaches the
 * technician immediately" (§9.4), cancellation carries "a structured reason
 * taxonomy ... because each drives different billing, payroll and outcome
 * consequences" (§6.4), and an amendment records "what changed, by whom, when
 * and why" (§6.6).
 */
export const REASON_REQUIRED = Object.freeze(['RETURNED', 'CANCELLED', 'AMENDED']);

/**
 * Cancellation reasons — §6.4 Cancellations. Reproduced as the blueprint lists
 * them; the taxonomy is not open-ended, because a free-text reason cannot drive
 * a billing or payroll consequence.
 */
export const CANCELLATION_REASONS = Object.freeze([
  'CLIENT_CANCEL',
  'PROVIDER_CANCEL',
  'NO_SHOW',
  'ILLNESS',
  'WEATHER',
  'HOLIDAY',
  'AGENCY',
]);

/** Is this a legal transition at all? */
export function canTransition(from, to) {
  return (SESSION_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Validates a requested transition, throwing INVALID_STATUS_TRANSITION when it
 * is not on the map. Enforced in the service, so no frontend button can
 * produce a state the backend did not sanction.
 */
export function assertTransition(from, to) {
  if (!SESSION_TRANSITIONS[from]) {
    throw sessionsError('INVALID_STATUS_TRANSITION', { message: `Unknown session state ${from}.` });
  }
  if (!canTransition(from, to)) {
    throw sessionsError('INVALID_STATUS_TRANSITION', {
      message: `A session that is ${humanState(from)} cannot become ${humanState(to)}.`,
    });
  }
}

/** Refuse any mutation once the record has become an immutable fact. */
export function assertMutable(status) {
  if (!MUTABLE_STATES.includes(status)) {
    throw sessionsError('SESSION_FROZEN');
  }
}

/** A reason is mandatory on return, cancellation and amendment. */
export function assertReason(to, reason) {
  if (!REASON_REQUIRED.includes(to)) return;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw sessionsError('REASON_REQUIRED', {
      message: to === 'RETURNED'
        ? 'Please say what needs fixing so the technician knows what to change.'
        : 'Please give a reason.',
    });
  }
}

/** A cancellation must carry a reason from the taxonomy, not free text alone. */
export function assertCancellationReason(code) {
  if (!CANCELLATION_REASONS.includes(code)) {
    throw sessionsError('INVALID_CANCELLATION_REASON', {
      message: 'Please choose a cancellation reason from the list.',
    });
  }
}

/**
 * SEPARATION OF DUTIES — BR-CN-2: "Only the assigned or supervising BCBA may
 * approve a session, and where separation of duties is enabled, never their
 * own." §4.5 states an RBT "cannot approve their own sessions" unconditionally.
 *
 * The self-approval check is therefore applied to the DELIVERING staff member
 * regardless of what permissions they also hold: a clinic owner who is also the
 * BCBA and also delivered the session is exactly the multi-role case §4.12
 * describes, and §4.12's separation-of-duties note flags "authoring a session
 * and approving it" as one of the three combinations to surface.
 *
 * @param {object} params
 * @param {string} params.deliveredByStaffId  who ran the session
 * @param {string} params.actorStaffId        who is trying to approve it
 * @param {boolean} params.separationOfDuties tenant policy (§4.12)
 */
export function assertMayApprove({ deliveredByStaffId, actorStaffId, separationOfDuties = true }) {
  if (!separationOfDuties) return;
  if (deliveredByStaffId && actorStaffId && deliveredByStaffId === actorStaffId) {
    throw sessionsError('SELF_APPROVAL_REFUSED', {
      message: 'A session has to be approved by someone other than the person who delivered it.',
    });
  }
}

/** Plain-language state names — never surface an enum to a user. */
export function humanState(status) {
  return {
    DRAFT: 'in progress',
    IN_PROGRESS: 'running',
    SUBMITTED: 'waiting for approval',
    RETURNED: 'returned for changes',
    FROZEN: 'approved',
    AMENDED: 'amended',
    CANCELLED: 'cancelled',
  }[status] ?? 'in an unknown state';
}

/**
 * BR-PR-1: "Only approved sessions contribute payable direct hours."
 * Payroll and billing both ask this question, and neither should reimplement it.
 */
export function contributesToPayroll(status) {
  return PAYROLL_ELIGIBLE_STATES.includes(status);
}

/**
 * The ONLY session states that contribute payable direct hours (BR-PR-1) and
 * that may become a claim line (BR-BL-1). Expressed as a shared constant so
 * payroll and billing derive from one answer rather than each hard-coding a
 * status string that then drifts when the lifecycle gains a state.
 *
 * AMENDED is deliberately excluded: an amended session has been superseded by
 * a new attributed record, and counting both would pay the hours twice.
 */
export const PAYROLL_ELIGIBLE_STATES = Object.freeze(['FROZEN']);
