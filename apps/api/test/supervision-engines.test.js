import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertObservationTransition, isObservationMutable, SUPERVISION_OBSERVATION_TRANSITIONS,
} from '../src/modules/supervision/supervision.state.js';
import {
  assertValidMinutes, sumMinutes, minutesToHours, summariseBySupervisee,
} from '../src/modules/supervision/supervision.hours.js';

// ---------------- state machine ----------------
test('valid observation transitions are allowed', () => {
  assert.doesNotThrow(() => assertObservationTransition('DRAFT', 'SUBMITTED'));
  assert.doesNotThrow(() => assertObservationTransition('SUBMITTED', 'SIGNED'));
  assert.doesNotThrow(() => assertObservationTransition('SUBMITTED', 'DRAFT'));
  assert.doesNotThrow(() => assertObservationTransition('DRAFT', 'DRAFT')); // no-op
});

test('invalid observation transitions are rejected', () => {
  assert.throws(() => assertObservationTransition('DRAFT', 'SIGNED'), /Illegal/);
  assert.throws(() => assertObservationTransition('SIGNED', 'DRAFT'), /Illegal/);
  assert.throws(() => assertObservationTransition('SIGNED', 'SUBMITTED'), /Illegal/);
  assert.throws(() => assertObservationTransition('SUPERSEDED', 'DRAFT'), /Illegal/);
  assert.throws(() => assertObservationTransition('BOGUS', 'DRAFT'), /Unknown/);
});

test('SIGNED and SUPERSEDED are terminal', () => {
  assert.deepEqual(SUPERVISION_OBSERVATION_TRANSITIONS.SIGNED, []);
  assert.deepEqual(SUPERVISION_OBSERVATION_TRANSITIONS.SUPERSEDED, []);
});

test('only DRAFT is mutable', () => {
  assert.equal(isObservationMutable('DRAFT'), true);
  assert.equal(isObservationMutable('SUBMITTED'), false);
  assert.equal(isObservationMutable('SIGNED'), false);
});

// ---------------- hours ----------------
test('assertValidMinutes accepts positive integers within a day', () => {
  assert.equal(assertValidMinutes(30), 30);
  assert.equal(assertValidMinutes(1440), 1440);
});

test('assertValidMinutes rejects zero, negatives, fractions, over-a-day', () => {
  assert.throws(() => assertValidMinutes(0), /positive/);
  assert.throws(() => assertValidMinutes(-5), /positive/);
  assert.throws(() => assertValidMinutes(1.5), /positive/);
  assert.throws(() => assertValidMinutes(1441), /24 hours/);
});

test('sumMinutes and minutesToHours compute totals', () => {
  assert.equal(sumMinutes([{ minutes: 30 }, { minutes: 90 }, { minutes: 0 }]), 120);
  assert.equal(minutesToHours(90), 1.5);
  assert.equal(minutesToHours(100), 1.67);
});

test('summariseBySupervisee groups and totals correctly', () => {
  const rows = [
    { superviseeStaffId: 'a', minutes: 60 },
    { superviseeStaffId: 'a', minutes: 30 },
    { superviseeStaffId: 'b', minutes: 45 },
  ];
  const out = summariseBySupervisee(rows).sort((x, y) => x.superviseeStaffId.localeCompare(y.superviseeStaffId));
  assert.deepEqual(out, [
    { superviseeStaffId: 'a', totalMinutes: 90, entries: 2, totalHours: 1.5 },
    { superviseeStaffId: 'b', totalMinutes: 45, entries: 1, totalHours: 0.75 },
  ]);
});
