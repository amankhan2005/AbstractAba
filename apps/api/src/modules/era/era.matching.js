/**
 * Deterministic ERA→claim matching engine. Pure: given one parsed ERA claim
 * record and the candidate claims already loaded from the DB, it returns a match
 * outcome. It never guesses — ambiguous or absent matches are surfaced for
 * manual resolution rather than silently matched.
 *
 * Matching order:
 *   1. payerControlNumber  (CLP07) against claim.payerControlNumber
 *   2. claimNumberRef      (CLP01) against claim.claimNumber
 *   3. fallback: claimNumberRef against claim._id (internal reference)
 *
 * Outcomes: MATCHED (exactly one), AMBIGUOUS (>1), UNMATCHED (0), INVALID
 * (record lacks any usable identifier or has a negative paid amount).
 */
export function matchEraRecord(record, candidateClaims) {
  if (!record || (!record.payerControlNumber && !record.claimNumberRef)) {
    return { status: 'INVALID', claimId: null, candidateIds: [] };
  }
  if (Number.isFinite(record.paidAmount) && record.paidAmount < 0) {
    return { status: 'INVALID', claimId: null, candidateIds: [] };
  }

  const byControl = record.payerControlNumber
    ? candidateClaims.filter((c) => c.payerControlNumber && c.payerControlNumber === record.payerControlNumber)
    : [];
  if (byControl.length === 1) return { status: 'MATCHED', claimId: byControl[0]._id, candidateIds: [] };
  if (byControl.length > 1) return { status: 'AMBIGUOUS', claimId: null, candidateIds: byControl.map((c) => c._id) };

  const byNumber = record.claimNumberRef
    ? candidateClaims.filter((c) => c.claimNumber === record.claimNumberRef)
    : [];
  if (byNumber.length === 1) return { status: 'MATCHED', claimId: byNumber[0]._id, candidateIds: [] };
  if (byNumber.length > 1) return { status: 'AMBIGUOUS', claimId: null, candidateIds: byNumber.map((c) => c._id) };

  const byId = record.claimNumberRef
    ? candidateClaims.filter((c) => c._id === record.claimNumberRef)
    : [];
  if (byId.length === 1) return { status: 'MATCHED', claimId: byId[0]._id, candidateIds: [] };

  return { status: 'UNMATCHED', claimId: null, candidateIds: [] };
}

/**
 * Determine reconciliation status for a claim given billed/paid/adjustment.
 * Pure. All values are integer minor units.
 */
export function reconciliationStatus({ billed, paid, adjustment }) {
  const covered = (paid ?? 0) + (adjustment ?? 0);
  if ((paid ?? 0) <= 0) return 'UNRECONCILED';
  if (covered >= billed) return 'RECONCILED';
  return 'PARTIALLY_PAID';
}
