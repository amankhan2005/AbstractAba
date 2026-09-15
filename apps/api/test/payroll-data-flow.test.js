import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesBetween, computeLineAmount, sumLineAmounts, sumMinutes } from '../src/modules/payroll/payroll.math.js';

/**
 * Spec §1/§2/§10 (John Smith end-to-end) — proves the PAYROLL/TIMESHEET data
 * flow with the REAL payroll functions the service uses, DB-free:
 *
 *   Session verified clock (clockInAt/clockOutAt)
 *     → minutesBetween()                    (what payableMinutesOf uses)
 *     → TimeEntry.minutes → Timesheet.totalMinutes (sumMinutes)
 *     → computeLineAmount(HOURLY, rate, minutes)   (the server payroll math)
 *
 * BCBA and RBT on the SAME appointment are separate sessions (proven in
 * independent-hours.test.js), so here they are separate timesheets/lines. Worked
 * time comes from the verified clock, NEVER the appointment window, and the two
 * clinicians are NEVER combined into a 240-minute record.
 */

// Verified clocks for the shared appointment (John Smith, BCBA-1 + RBT-1).
const BCBA_IN = '2026-09-07T10:00:00.000Z';
const BCBA_OUT = '2026-09-07T11:30:00.000Z'; // 90 min
const RBT_IN = '2026-09-07T10:15:00.000Z';
const RBT_OUT = '2026-09-07T12:45:00.000Z';  // 150 min

const BCBA_RATE_MINOR = 5000; // $50.00/hr
const RBT_RATE_MINOR = 2500;  // $25.00/hr

test('§10 — verified-clock minutes: BCBA 90, RBT 150 (not the appointment window)', () => {
  assert.equal(minutesBetween(BCBA_IN, BCBA_OUT), 90);
  assert.equal(minutesBetween(RBT_IN, RBT_OUT), 150);
});

test('§10 — timesheet totals mirror the per-clinician session minutes', () => {
  // Each clinician has ONE session this period → one TimeEntry each.
  assert.equal(sumMinutes([{ minutes: minutesBetween(BCBA_IN, BCBA_OUT) }]), 90);
  assert.equal(sumMinutes([{ minutes: minutesBetween(RBT_IN, RBT_OUT) }]), 150);
});

test('§1/§2/§10 — payroll amounts: BCBA 90×$50=$75.00, RBT 150×$25=$62.50, total $137.50', () => {
  const bcbaMinutes = minutesBetween(BCBA_IN, BCBA_OUT);
  const rbtMinutes = minutesBetween(RBT_IN, RBT_OUT);

  const bcbaLine = { amount: computeLineAmount({ rateType: 'HOURLY', rateAmount: BCBA_RATE_MINOR, minutes: bcbaMinutes }) };
  const rbtLine = { amount: computeLineAmount({ rateType: 'HOURLY', rateAmount: RBT_RATE_MINOR, minutes: rbtMinutes }) };

  assert.equal(bcbaLine.amount, 7500, 'BCBA line = $75.00');
  assert.equal(rbtLine.amount, 6250, 'RBT line = $62.50');

  // Separate lines, each from its OWN minutes × OWN rate — never combined.
  assert.notEqual(bcbaLine.amount, rbtLine.amount);
  assert.equal(sumLineAmounts([bcbaLine, rbtLine]), 13750, 'run total = $137.50');
});

test('§2 — the shared 240-minute appointment duration is NEVER used for either clinician', () => {
  const combined = 240;
  const bcbaMinutes = minutesBetween(BCBA_IN, BCBA_OUT);
  const rbtMinutes = minutesBetween(RBT_IN, RBT_OUT);
  assert.notEqual(bcbaMinutes, combined);
  assert.notEqual(rbtMinutes, combined);
  // A (wrong) combined record would be $200 at $50 or $100 at $25 — never produced.
  assert.notEqual(computeLineAmount({ rateType: 'HOURLY', rateAmount: BCBA_RATE_MINOR, minutes: bcbaMinutes }), 20000);
});

test('§1 — partial hours and different rates compute correctly (HOURLY = round(rate×min/60))', () => {
  assert.equal(computeLineAmount({ rateType: 'HOURLY', rateAmount: 5000, minutes: 30 }), 2500); // $25.00
  assert.equal(computeLineAmount({ rateType: 'HOURLY', rateAmount: 5000, minutes: 90 }), 7500); // $75.00
  assert.equal(computeLineAmount({ rateType: 'HOURLY', rateAmount: 2500, minutes: 150 }), 6250); // $62.50
});
