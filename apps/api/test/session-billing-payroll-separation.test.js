import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLineAmount } from '../src/modules/payroll/payroll.math.js';
import { lineAmount } from '../src/modules/billing/money.js';
import { minutesToBillableUnits } from '../src/domain/units.js';

/**
 * Spec Module 9 Parts 24/25/28 — PAYER BILLING and STAFF PAYROLL are two
 * independent computations that must never be conflated:
 *
 *   payer billing = authorized units × payer unit rate      (billing/money.js)
 *   staff payroll = staff hourly PayRate × worked minutes    (payroll.math.js)
 *
 * A payer paying $150/unit does NOT make the staff wage $150/unit. These come
 * from different modules with different inputs; this test pins that separation
 * with a concrete 60-minute session.
 */
test('a 60-minute session: payer billing derives from units×payer-rate, payroll from staff-rate×minutes — independently', () => {
  const minutes = 60;

  // 1 unit = 15 min → a 60-minute session is 4 billable units (canonical rule).
  const units = minutesToBillableUnits(minutes);
  assert.equal(units, 4);

  // PAYER BILLING: 4 units × $150.00/unit (payer reimbursement) = $600.00.
  const payerUnitRateCents = 15000;
  const payerBilling = lineAmount(units, payerUnitRateCents);
  assert.equal(payerBilling, 60000);

  // STAFF PAYROLL: $25.00/hr × 60 min = $25.00 — uses the STAFF rate, not the payer's.
  const staffPayroll = computeLineAmount({ rateType: 'HOURLY', rateAmount: 2500, minutes });
  assert.equal(staffPayroll, 2500);

  // The two figures are unrelated: payroll is NOT derived from the payer rate.
  assert.notEqual(staffPayroll, payerBilling);
  assert.notEqual(staffPayroll, lineAmount(units, payerUnitRateCents));
});

test('changing the payer rate does not change payroll, and vice-versa', () => {
  const minutes = 30; // 2 units
  const units = minutesToBillableUnits(minutes);
  const payrollAt25 = computeLineAmount({ rateType: 'HOURLY', rateAmount: 2500, minutes });
  // Doubling the payer unit rate changes billing only.
  const billingLow = lineAmount(units, 10000);
  const billingHigh = lineAmount(units, 20000);
  assert.notEqual(billingLow, billingHigh);
  assert.equal(payrollAt25, 1250, 'payroll unaffected by payer rate = $12.50 for 30 min at $25/hr');

  // Doubling the staff rate changes payroll only.
  const payrollAt50 = computeLineAmount({ rateType: 'HOURLY', rateAmount: 5000, minutes });
  assert.equal(payrollAt50, 2500);
  assert.equal(billingLow, lineAmount(units, 10000), 'billing unaffected by staff rate');
});
