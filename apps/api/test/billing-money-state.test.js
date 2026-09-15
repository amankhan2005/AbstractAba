import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInvoiceTotals, lineAmount, assertNonNegativeInt } from '../src/modules/billing/money.js';
import {
  assertSubscriptionTransition,
  assertInvoiceTransition,
  assertPaymentTransition,
} from '../src/modules/billing/billing.state.js';

test('lineAmount multiplies quantity by unit (minor units, integer result)', () => {
  assert.equal(lineAmount(3, 1000), 3000);
  assert.equal(lineAmount(1, 4999), 4999);
});

test('computeInvoiceTotals: subtotal + tax - credits, floored, amountDue derived', () => {
  const t = computeInvoiceTotals({
    lines: [{ amount: 5000 }, { amount: 2500 }],
    tax: 600,
    creditsApplied: 1000,
    amountPaid: 0,
  });
  assert.deepEqual(t, { subtotal: 7500, tax: 600, creditsApplied: 1000, total: 7100, amountPaid: 0, amountDue: 7100 });
});

test('computeInvoiceTotals floors total and amountDue at zero', () => {
  const t = computeInvoiceTotals({ lines: [{ amount: 1000 }], tax: 0, creditsApplied: 5000, amountPaid: 0 });
  assert.equal(t.total, 0);
  assert.equal(t.amountDue, 0);
});

test('computeInvoiceTotals reduces amountDue by amountPaid', () => {
  const t = computeInvoiceTotals({ lines: [{ amount: 10000 }], tax: 0, creditsApplied: 0, amountPaid: 4000 });
  assert.equal(t.amountDue, 6000);
});

test('assertNonNegativeInt rejects floats and negatives', () => {
  assert.throws(() => assertNonNegativeInt(10.5), /minor units/);
  assert.throws(() => assertNonNegativeInt(-1), /minor units/);
});

test('subscription transitions enforce the state machine', () => {
  assert.doesNotThrow(() => assertSubscriptionTransition('TRIALING', 'ACTIVE'));
  assert.doesNotThrow(() => assertSubscriptionTransition('ACTIVE', 'PAST_DUE'));
  assert.doesNotThrow(() => assertSubscriptionTransition('ACTIVE', 'SUSPENDED'));
  assert.doesNotThrow(() => assertSubscriptionTransition('SUSPENDED', 'ACTIVE'));
  assert.doesNotThrow(() => assertSubscriptionTransition('ACTIVE', 'ACTIVE')); // idempotent
  assert.throws(() => assertSubscriptionTransition('CANCELED', 'ACTIVE'), /Illegal/);
  assert.throws(() => assertSubscriptionTransition('TRIALING', 'SUSPENDED'), /Illegal/);
});

test('invoice transitions enforce the state machine', () => {
  assert.doesNotThrow(() => assertInvoiceTransition('DRAFT', 'OPEN'));
  assert.doesNotThrow(() => assertInvoiceTransition('OPEN', 'PAID'));
  assert.throws(() => assertInvoiceTransition('PAID', 'OPEN'), /Illegal/);
  assert.throws(() => assertInvoiceTransition('VOID', 'PAID'), /Illegal/);
});

test('payment transitions enforce the state machine', () => {
  assert.doesNotThrow(() => assertPaymentTransition('PENDING', 'SUCCEEDED'));
  assert.doesNotThrow(() => assertPaymentTransition('SUCCEEDED', 'REFUNDED'));
  assert.throws(() => assertPaymentTransition('FAILED', 'SUCCEEDED'), /Illegal/);
  assert.throws(() => assertPaymentTransition('REFUNDED', 'SUCCEEDED'), /Illegal/);
});

// Partial-payment balance math (authoritative, server-side).
test('partial payments reduce balance and only reach zero when fully paid', () => {
  // $1000 invoice, pay $400 then $600 -> PAID
  let t = computeInvoiceTotals({ lines: [{ amount: 100000 }], tax: 0, creditsApplied: 0, amountPaid: 40000 });
  assert.equal(t.amountDue, 60000);
  t = computeInvoiceTotals({ lines: [{ amount: 100000 }], tax: 0, creditsApplied: 0, amountPaid: 100000 });
  assert.equal(t.amountDue, 0);
});
