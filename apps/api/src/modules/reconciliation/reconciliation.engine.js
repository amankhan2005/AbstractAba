import { AppError } from '../../common/errors/AppError.js';

/**
 * Pure reconciliation engine. All money is integer minor units (cents); no
 * floating point. Given authoritative billed/paid/adjustment amounts it computes
 * the remaining amount and classifies the reconciliation posture, surfacing
 * discrepancies rather than hiding them.
 *
 *   remainingAmount = billedAmount - paidAmount - adjustmentAmount
 */
export function computeReconciliation({ billedAmount, paidAmount, adjustmentAmount }) {
  for (const [k, v] of Object.entries({ billedAmount, paidAmount, adjustmentAmount })) {
    if (!Number.isInteger(v) || v < 0) throw AppError.validation(`${k} must be a non-negative integer (minor units).`);
  }
  const remainingAmount = billedAmount - paidAmount - adjustmentAmount;
  const covered = paidAmount + adjustmentAmount;

  let status;
  const flags = [];
  if (covered === 0) {
    status = 'UNRECONCILED';
  } else if (remainingAmount === 0) {
    status = 'RECONCILED';
  } else if (remainingAmount > 0) {
    status = 'PARTIAL';
  } else {
    // covered > billed -> overpayment / excess adjustment -> discrepancy
    status = 'DISCREPANCY';
    if (paidAmount > billedAmount) flags.push('OVERPAYMENT');
    if (adjustmentAmount > billedAmount) flags.push('EXCESS_ADJUSTMENT');
    if (flags.length === 0) flags.push('OVERCOVERED');
  }
  return { billedAmount, paidAmount, adjustmentAmount, remainingAmount, status, flags };
}

/**
 * Detect discrepancies across a claim and its posted ERA payments/adjustments.
 * Pure. Returns a list of discrepancy codes (empty = consistent).
 */
export function detectClaimDiscrepancies({ claim, eraPayments = [], postedPaymentIds = [] }) {
  const codes = [];
  const paidFromEra = eraPayments.reduce((s, p) => s + (p.paidAmount || 0), 0);
  if (claim.paidAmount != null && paidFromEra > 0 && claim.paidAmount !== paidFromEra) {
    // claim.paidAmount should equal the sum of posted ERA payments
    if (claim.paidAmount !== paidFromEra) codes.push('PAID_TOTAL_MISMATCH');
  }
  // duplicate ERA posting: same postedPaymentId appearing more than once
  const seen = new Set();
  for (const id of postedPaymentIds) {
    if (seen.has(id)) { codes.push('DUPLICATE_REMITTANCE'); break; }
    seen.add(id);
  }
  if (claim.totalCharge != null && claim.paidAmount > claim.totalCharge + (claim.adjustmentAmount || 0)) {
    codes.push('OVERPAYMENT');
  }
  return codes;
}

/** Sum helper for report totals (minor units). Rejects invalid values. */
export function sumMinor(values) {
  let total = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw AppError.validation('amount must be an integer (minor units).');
    total += v;
  }
  return total;
}

/** Collection rate as a percentage (0-100, one decimal), from minor units. */
export function collectionRate({ billed, collected }) {
  if (!billed || billed <= 0) return 0;
  return Math.round((collected / billed) * 1000) / 10;
}
