import { AppError } from '../../common/errors/AppError.js';

/**
 * Reconciliation workflow state machine (distinct from claim lifecycle).
 *
 *   UNRECONCILED ─▶ REVIEWING ─▶ RECONCILED
 *        │             │
 *        ▼             ▼
 *     PARTIAL      DISCREPANCY ─▶ RESOLVED
 *
 * PARTIAL and DISCREPANCY are reachable from review as the picture becomes clear;
 * RESOLVED and RECONCILED are terminal.
 */
export const RECONCILIATION_TRANSITIONS = Object.freeze({
  UNRECONCILED: ['REVIEWING', 'PARTIAL', 'RECONCILED', 'DISCREPANCY'],
  REVIEWING: ['RECONCILED', 'PARTIAL', 'DISCREPANCY'],
  PARTIAL: ['REVIEWING', 'RECONCILED', 'DISCREPANCY'],
  DISCREPANCY: ['REVIEWING', 'RESOLVED'],
  RECONCILED: [],
  RESOLVED: [],
});

export function assertReconciliationTransition(from, to) {
  const allowed = RECONCILIATION_TRANSITIONS[from];
  if (!allowed) throw AppError.conflict('RECON-409', `Unknown reconciliation status: ${from}`);
  if (from === to) return;
  if (!allowed.includes(to)) throw AppError.conflict('RECON-409', `Illegal reconciliation transition ${from} -> ${to}`);
}
