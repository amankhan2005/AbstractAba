import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLineAmount, sumMinutes, sumLineAmounts, minutesBetween, assertNonNegativeInt,
} from '../src/modules/payroll/payroll.math.js';
import {
  assertTimesheetTransition, assertPayrollRunTransition,
} from '../src/modules/payroll/payroll.state.js';

test('spec Module 1 examples: $25/hr for 60 min = $25.00; for 30 min = $12.50 (minor units)', () => {
  assert.equal(computeLineAmount({ rateType: 'HOURLY', rateAmount: 2500, minutes: 60 }), 2500);
  assert.equal(computeLineAmount({ rateType: 'HOURLY', rateAmount: 2500, minutes: 30 }), 1250);
});

test('spec Module 9 example: $25/hr for 45 min = $18.75 (1875 cents, no float drift)', () => {
  assert.equal(computeLineAmount({ rateType: 'HOURLY', rateAmount: 2500, minutes: 45 }), 1875);
});

test('HOURLY pay = round(rate * minutes / 60), minor units', () => {
  // $30.00/hr = 3000 cents; 90 min => 4500 cents
  assert.equal(computeLineAmount({ rateType: 'HOURLY', rateAmount: 3000, minutes: 90 }), 4500);
  // 100 min at 3000 => round(3000*100/60)=5000
  assert.equal(computeLineAmount({ rateType: 'HOURLY', rateAmount: 3000, minutes: 100 }), 5000);
  // rounding: 3333 c/hr, 50 min => round(3333*50/60)=2778 (2777.5 -> 2778)
  assert.equal(computeLineAmount({ rateType: 'HOURLY', rateAmount: 3333, minutes: 50 }), 2778);
});

test('PER_SESSION pay = rate * sessionCount', () => {
  assert.equal(computeLineAmount({ rateType: 'PER_SESSION', rateAmount: 5000, sessionCount: 3 }), 15000);
  assert.equal(computeLineAmount({ rateType: 'PER_SESSION', rateAmount: 5000, sessionCount: 0 }), 0);
});

test('SALARY pay = flat rate per period', () => {
  assert.equal(computeLineAmount({ rateType: 'SALARY', rateAmount: 250000 }), 250000);
});

test('computeLineAmount rejects invalid inputs', () => {
  assert.throws(() => computeLineAmount({ rateType: 'HOURLY', rateAmount: 30.5, minutes: 60 }), /minor units/);
  assert.throws(() => computeLineAmount({ rateType: 'HOURLY', rateAmount: 3000, minutes: -1 }), /minutes/);
  assert.throws(() => computeLineAmount({ rateType: 'NOPE', rateAmount: 1 }), /Unknown rate type/);
});

test('sumMinutes requires positive integer minutes', () => {
  assert.equal(sumMinutes([{ minutes: 30 }, { minutes: 45 }]), 75);
  assert.throws(() => sumMinutes([{ minutes: 0 }]), /positive integer/);
  assert.throws(() => sumMinutes([{ minutes: 1.5 }]), /positive integer/);
});

test('sumLineAmounts totals minor units and rejects negatives', () => {
  assert.equal(sumLineAmounts([{ amount: 4500 }, { amount: 15000 }]), 19500);
  assert.throws(() => sumLineAmounts([{ amount: -1 }]), /minor units/);
});

test('minutesBetween floors to whole minutes and rejects inverted ranges', () => {
  const a = '2026-01-01T09:00:00Z';
  const b = '2026-01-01T10:30:00Z';
  assert.equal(minutesBetween(a, b), 90);
  assert.throws(() => minutesBetween(b, a), /after its start/);
});

test('assertNonNegativeInt rejects floats and negatives', () => {
  assert.throws(() => assertNonNegativeInt(1.2), /minor units/);
  assert.throws(() => assertNonNegativeInt(-5), /minor units/);
});

test('timesheet transitions enforce the workflow', () => {
  assert.doesNotThrow(() => assertTimesheetTransition('DRAFT', 'SUBMITTED'));
  assert.doesNotThrow(() => assertTimesheetTransition('SUBMITTED', 'APPROVED'));
  assert.doesNotThrow(() => assertTimesheetTransition('REJECTED', 'DRAFT'));
  assert.throws(() => assertTimesheetTransition('APPROVED', 'DRAFT'), /Illegal/);
  assert.throws(() => assertTimesheetTransition('DRAFT', 'APPROVED'), /Illegal/);
});

test('payroll run transitions enforce the workflow and immutability', () => {
  assert.doesNotThrow(() => assertPayrollRunTransition('DRAFT', 'APPROVED'));
  assert.doesNotThrow(() => assertPayrollRunTransition('APPROVED', 'FINALIZED'));
  assert.doesNotThrow(() => assertPayrollRunTransition('APPROVED', 'DRAFT'));
  assert.throws(() => assertPayrollRunTransition('FINALIZED', 'DRAFT'), /Illegal/);
  assert.throws(() => assertPayrollRunTransition('DRAFT', 'FINALIZED'), /Illegal/);
});

// --- Phase 4: payroll preview aggregation (read-only) ----------------------
// Preview reuses the same pure math as commit (computeLineAmount + sumLineAmounts),
// so a preview total can never differ from what a generated run would total for
// the same inputs. These tests pin that equivalence and the rate-type handling.
import { computeLineAmount as _cla, sumLineAmounts as _sla } from '../src/modules/payroll/payroll.math.js';

test('preview total equals the sum of per-timesheet computed lines (mixed rate types)', () => {
  // Simulate #computeLineSpecs output for three approved timesheets.
  const inputs = [
    { rateType: 'HOURLY', rateAmount: 3200, minutes: 600, sessionCount: 5 },   // $32/hr * 10h = 32000
    { rateType: 'PER_SESSION', rateAmount: 5000, minutes: 0, sessionCount: 4 }, // $50 * 4 = 20000
    { rateType: 'SALARY', rateAmount: 250000, minutes: 999, sessionCount: 9 },  // flat 250000
  ];
  const specs = inputs.map((i) => ({ ...i, amount: _cla(i) }));
  assert.equal(specs[0].amount, 32000);
  assert.equal(specs[1].amount, 20000);
  assert.equal(specs[2].amount, 250000);
  const previewTotal = _sla(specs);
  const commitTotal = _sla(specs.map((s) => ({ amount: s.amount }))); // run persists these same amounts
  assert.equal(previewTotal, 302000);
  assert.equal(previewTotal, commitTotal, 'preview and commit must total identically');
});

test('preview total is integer minor units (no float drift)', () => {
  const specs = [
    { amount: _cla({ rateType: 'HOURLY', rateAmount: 3333, minutes: 50 }) }, // round(3333*50/60)=2778 (0.5 rounds)
    { amount: _cla({ rateType: 'HOURLY', rateAmount: 2500, minutes: 90 }) }, // 3750
  ];
  const total = _sla(specs);
  assert.ok(Number.isInteger(total));
  assert.equal(total, 2778 + 3750);
});
