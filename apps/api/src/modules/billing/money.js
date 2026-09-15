import { AppError } from '../../common/errors/AppError.js';

/**
 * Money helpers. All amounts are integer minor units (cents). No floating point
 * is ever used for authoritative values. These are pure and unit-tested.
 */
export function assertNonNegativeInt(value, field = 'amount') {
  if (!Number.isInteger(value) || value < 0) {
    throw AppError.validation(`${field} must be a non-negative integer (minor units).`);
  }
}

export function lineAmount(quantity, unitAmount) {
  if (!Number.isInteger(unitAmount)) throw AppError.validation('unitAmount must be an integer.');
  if (!Number.isFinite(quantity) || quantity < 0) throw AppError.validation('quantity must be >= 0.');
  return Math.round(quantity * unitAmount);
}

/**
 * Compute authoritative invoice totals from line items, tax and credits.
 * subtotal = sum(line.amount); total = subtotal + tax - credits (floored at 0);
 * amountDue = total - amountPaid (floored at 0).
 */
export function computeInvoiceTotals({ lines, tax = 0, creditsApplied = 0, amountPaid = 0 }) {
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  assertNonNegativeInt(subtotal, 'subtotal');
  assertNonNegativeInt(tax, 'tax');
  assertNonNegativeInt(creditsApplied, 'creditsApplied');
  assertNonNegativeInt(amountPaid, 'amountPaid');
  const total = Math.max(0, subtotal + tax - creditsApplied);
  const amountDue = Math.max(0, total - amountPaid);
  return { subtotal, tax, creditsApplied, total, amountPaid, amountDue };
}
