import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINUTES_PER_UNIT,
  unitsToMinutes,
  minutesToUnits,
  minutesToBillableUnits,
  unitsToHours,
} from '../src/domain/units.js';
import { defaultUnits } from '../src/modules/scheduling/scheduling.rules.js';

/**
 * Spec Module 6 Parts 8/9/10 — ONE canonical rule: 1 unit = 15 minutes, used by
 * authorization, scheduling, sessions and billing. Hours are derived from units.
 */
test('the canonical rule is 1 unit = 15 minutes', () => {
  assert.equal(MINUTES_PER_UNIT, 15);
});

test('minutes → units: 15/30/45/60 = 1/2/3/4', () => {
  assert.equal(minutesToBillableUnits(15), 1);
  assert.equal(minutesToBillableUnits(30), 2);
  assert.equal(minutesToBillableUnits(45), 3);
  assert.equal(minutesToBillableUnits(60), 4);
});

test('units → minutes is the exact inverse', () => {
  assert.equal(unitsToMinutes(1), 15);
  assert.equal(unitsToMinutes(4), 60);
  assert.equal(unitsToMinutes(120), 1800);
});

test('exact minutesToUnits allows fractions; billable rounds and floors at 1', () => {
  assert.equal(minutesToUnits(30), 2);
  assert.equal(minutesToUnits(37.5), 2.5);
  assert.equal(minutesToBillableUnits(5), 1); // never zero for a real appointment
});

test('hours derived from units: 120 units = 30 hours (Part 9 example)', () => {
  assert.equal(unitsToHours(120), 30);
  assert.equal(unitsToHours(4), 1);
  assert.equal(unitsToHours(160), 40);
});

test('scheduling.defaultUnits delegates to the same canonical rule', () => {
  assert.equal(defaultUnits(60), minutesToBillableUnits(60));
  assert.equal(defaultUnits(30), 2);
  assert.equal(defaultUnits(0), 1); // guard: at least one unit
});

test('guards: negative / non-finite inputs never produce NaN or negatives', () => {
  assert.equal(unitsToMinutes(-5), 0);
  assert.equal(unitsToHours(-5), 0);
  assert.equal(minutesToUnits(-5), 0);
  assert.equal(minutesToBillableUnits(-5), 1);
  assert.equal(Number.isNaN(unitsToHours('x')), false);
});
