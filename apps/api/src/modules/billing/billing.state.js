import { AppError } from '../../common/errors/AppError.js';

/**
 * Server-side state machines for billing. Every transition is validated here;
 * the frontend can never set a status directly. Illegal transitions throw a
 * conflict so callers get a clear, auditable failure.
 */
export const SUBSCRIPTION_TRANSITIONS = Object.freeze({
  TRIALING: ['ACTIVE', 'PAST_DUE', 'CANCELED'],
  ACTIVE: ['PAST_DUE', 'SUSPENDED', 'CANCELED'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'CANCELED'],
  SUSPENDED: ['ACTIVE', 'CANCELED'],
  CANCELED: [],
});

export const INVOICE_TRANSITIONS = Object.freeze({
  DRAFT: ['OPEN', 'VOID'],
  OPEN: ['PAID', 'VOID', 'UNCOLLECTIBLE'],
  PAID: [],
  VOID: [],
  UNCOLLECTIBLE: ['PAID', 'VOID'],
});

export const PAYMENT_TRANSITIONS = Object.freeze({
  PENDING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: ['REFUNDED'],
  FAILED: [],
  REFUNDED: [],
});

function assertTransition(map, kind, from, to) {
  const allowed = map[from];
  if (!allowed) throw AppError.conflict('BILLING-409', `Unknown ${kind} status: ${from}`);
  if (from === to) return; // idempotent no-op
  if (!allowed.includes(to)) {
    throw AppError.conflict('BILLING-409', `Illegal ${kind} transition ${from} -> ${to}`);
  }
}

export const assertSubscriptionTransition = (from, to) =>
  assertTransition(SUBSCRIPTION_TRANSITIONS, 'subscription', from, to);
export const assertInvoiceTransition = (from, to) =>
  assertTransition(INVOICE_TRANSITIONS, 'invoice', from, to);
export const assertPaymentTransition = (from, to) =>
  assertTransition(PAYMENT_TRANSITIONS, 'payment', from, to);
