import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandOccurrences, validateRecurrenceRule } from '../src/modules/scheduling/recurrence.js';

const d = (s) => new Date(s);
const base = { startMinute: 9 * 60, endMinute: 10 * 60 }; // 09:00–10:00 UTC

test('DAILY interval 1 with count produces N consecutive days', () => {
  const occ = expandOccurrences({ ...base, frequency: 'DAILY', interval: 1, startDate: d('2026-03-02T00:00:00Z'), count: 3 });
  assert.equal(occ.length, 3);
  assert.equal(occ[0].startAt.toISOString(), '2026-03-02T09:00:00.000Z');
  assert.equal(occ[0].endAt.toISOString(), '2026-03-02T10:00:00.000Z');
  assert.equal(occ[1].startAt.toISOString(), '2026-03-03T09:00:00.000Z');
  assert.equal(occ[2].startAt.toISOString(), '2026-03-04T09:00:00.000Z');
});

test('DAILY interval 2 skips every other day', () => {
  const occ = expandOccurrences({ ...base, frequency: 'DAILY', interval: 2, startDate: d('2026-03-02T00:00:00Z'), count: 3 });
  assert.deepEqual(occ.map((o) => o.startAt.toISOString().slice(0, 10)), ['2026-03-02', '2026-03-04', '2026-03-06']);
});

test('DAILY bounded by untilDate stops at the boundary (inclusive)', () => {
  const occ = expandOccurrences({ ...base, frequency: 'DAILY', interval: 1, startDate: d('2026-03-02T00:00:00Z'), untilDate: d('2026-03-04T00:00:00Z') });
  assert.equal(occ.length, 3); // 2,3,4
});

test('WEEKLY with byWeekday emits selected days each week', () => {
  // 2026-03-02 is a Monday. Mon=1, Wed=3.
  const occ = expandOccurrences({ ...base, frequency: 'WEEKLY', interval: 1, byWeekday: [1, 3], startDate: d('2026-03-02T00:00:00Z'), count: 4 });
  assert.deepEqual(occ.map((o) => o.startAt.toISOString().slice(0, 10)), ['2026-03-02', '2026-03-04', '2026-03-09', '2026-03-11']);
});

test('WEEKLY interval 2 skips a week between occurrences', () => {
  const occ = expandOccurrences({ ...base, frequency: 'WEEKLY', interval: 2, byWeekday: [1], startDate: d('2026-03-02T00:00:00Z'), count: 3 });
  assert.deepEqual(occ.map((o) => o.startAt.toISOString().slice(0, 10)), ['2026-03-02', '2026-03-16', '2026-03-30']);
});

test('afterDate skips already-materialized occurrences', () => {
  const occ = expandOccurrences({ ...base, frequency: 'DAILY', interval: 1, startDate: d('2026-03-02T00:00:00Z'), count: 5 }, { afterDate: d('2026-03-03T12:00:00Z') });
  assert.deepEqual(occ.map((o) => o.startAt.toISOString().slice(0, 10)), ['2026-03-04', '2026-03-05', '2026-03-06']);
});

test('validateRecurrenceRule rejects unbounded rules', () => {
  assert.throws(() => validateRecurrenceRule({ frequency: 'DAILY', interval: 1, startDate: d('2026-03-02T00:00:00Z'), startMinute: 540, endMinute: 600 }), /bounded/);
});

test('validateRecurrenceRule rejects bad interval, weekday, and time window', () => {
  assert.throws(() => validateRecurrenceRule({ frequency: 'DAILY', interval: 0, startDate: d('2026-03-02'), count: 1, startMinute: 540, endMinute: 600 }), /interval/);
  assert.throws(() => validateRecurrenceRule({ frequency: 'WEEKLY', interval: 1, byWeekday: [9], startDate: d('2026-03-02'), count: 1, startMinute: 540, endMinute: 600 }), /weekday/i);
  assert.throws(() => validateRecurrenceRule({ frequency: 'DAILY', interval: 1, startDate: d('2026-03-02'), count: 1, startMinute: 600, endMinute: 600 }), /endMinute/);
});

test('count cap and until-before-start are rejected', () => {
  assert.throws(() => validateRecurrenceRule({ frequency: 'DAILY', interval: 1, startDate: d('2026-03-02'), count: 5000, startMinute: 540, endMinute: 600 }), /count/);
  assert.throws(() => validateRecurrenceRule({ frequency: 'DAILY', interval: 1, startDate: d('2026-03-10'), untilDate: d('2026-03-01'), startMinute: 540, endMinute: 600 }), /before the start/);
});

test('expansion is chronologically ordered', () => {
  const occ = expandOccurrences({ ...base, frequency: 'WEEKLY', interval: 1, byWeekday: [5, 1, 3], startDate: d('2026-03-02T00:00:00Z'), count: 6 });
  for (let i = 1; i < occ.length; i += 1) assert.ok(occ[i].startAt >= occ[i - 1].startAt);
});
