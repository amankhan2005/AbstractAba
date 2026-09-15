import { AppError } from '../../common/errors/AppError.js';

/**
 * Server-side claim lifecycle state machine.
 *
 *   DRAFT ─▶ SUBMITTED ─▶ ACCEPTED ─▶ PAID ─▶ CLOSED
 *              │  ▲          │
 *              ▼  │          ▼
 *           REJECTED      DENIED
 *              │             │
 *              ▼             ▼
 *          RESUBMITTED ─▶ SUBMITTED (via resubmit)
 *
 * RESUBMITTED is a transient state that immediately allows re-entering
 * SUBMITTED. PAID/CLOSED are terminal (CLOSED fully terminal).
 */
export const CLAIM_TRANSITIONS = Object.freeze({
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['PAID', 'DENIED'],
  REJECTED: ['RESUBMITTED'],
  DENIED: ['RESUBMITTED'],
  RESUBMITTED: ['SUBMITTED'],
  PAID: ['CLOSED'],
  CLOSED: [],
});

export function assertClaimTransition(from, to) {
  const allowed = CLAIM_TRANSITIONS[from];
  if (!allowed) throw AppError.conflict('CLAIM-409', `Unknown claim status: ${from}`);
  if (from === to) return; // idempotent
  if (!allowed.includes(to)) throw AppError.conflict('CLAIM-409', `Illegal claim transition ${from} -> ${to}`);
}
