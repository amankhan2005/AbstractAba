import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBookingInput, assertAssignedRole } from '../src/modules/scheduling/booking.js';

/**
 * Unit coverage for the pure booking core (spec §5–§8). These run with zero I/O,
 * which is what makes the create path deterministic and non-hanging: every
 * branch returns synchronously or throws a structured error.
 */

const base = {
  clientId: 'c-1', bcbaId: 'bcba-1', rbtId: 'rbt-1', authorizationIds: ['a-1'],
  startDate: '2026-09-05', endDate: '2026-09-05', startTime: '09:00', units: 4,
};

test('composes UTC start/end from date + time; RBT mirrors staffProfileId', () => {
  const b = normalizeBookingInput(base);
  assert.equal(b.startAt.toISOString(), '2026-09-05T09:00:00.000Z');
  // no endTime → derived from units (4 * 15min = 60min)
  assert.equal(b.endAt.toISOString(), '2026-09-05T10:00:00.000Z');
  assert.equal(b.staffProfileId, 'rbt-1');
  assert.equal(b.authorizationId, 'a-1');
});

test('uses an explicit endTime when provided', () => {
  const b = normalizeBookingInput({ ...base, endTime: '11:30' });
  assert.equal(b.endAt.toISOString(), '2026-09-05T11:30:00.000Z');
});

test('de-duplicates authorizations, keeps first as primary', () => {
  const b = normalizeBookingInput({ ...base, authorizationIds: ['a-1', 'a-2', 'a-1'] });
  assert.deepEqual(b.authorizationIds, ['a-1', 'a-2']);
  assert.equal(b.authorizationId, 'a-1');
});

test('rejects missing authorizations', () => {
  assert.throws(() => normalizeBookingInput({ ...base, authorizationIds: [] }), (e) => e.code === 'NO_AUTHORIZATION');
});

test('rejects non-positive / non-integer units', () => {
  assert.throws(() => normalizeBookingInput({ ...base, units: 0 }), (e) => e.code === 'UNITS_INVALID');
  assert.throws(() => normalizeBookingInput({ ...base, units: -1 }), (e) => e.code === 'UNITS_INVALID');
  assert.throws(() => normalizeBookingInput({ ...base, units: 'abc' }), (e) => e.code === 'UNITS_INVALID');
  assert.throws(() => normalizeBookingInput({ ...base, units: 2.5 }), (e) => e.code === 'UNITS_INVALID');
});

test('rejects an invalid start and an end-before-start window', () => {
  assert.throws(() => normalizeBookingInput({ ...base, startDate: '', startAt: '' }), (e) => e.code === 'INVALID_TIME_RANGE');
  assert.throws(() => normalizeBookingInput({ ...base, startTime: '10:00', endTime: '09:00' }), (e) => e.code === 'END_BEFORE_START');
});

test('accepts the legacy composed shape too (staffProfileId + authorizationId + startAt/endAt)', () => {
  const b = normalizeBookingInput({
    clientId: 'c-1', staffProfileId: 'rbt-1', authorizationId: 'a-9',
    startAt: '2026-09-05T15:00:00.000Z', endAt: '2026-09-05T16:00:00.000Z', units: 4,
  });
  assert.equal(b.rbtId, 'rbt-1');
  assert.deepEqual(b.authorizationIds, ['a-9']);
  assert.equal(b.startAt.toISOString(), '2026-09-05T15:00:00.000Z');
});

test('assertAssignedRole enforces an ACTIVE role match', () => {
  const team = [
    { staffProfileId: 'bcba-1', role: 'BCBA', status: 'ACTIVE' },
    { staffProfileId: 'rbt-old', role: 'RBT', status: 'ENDED' },
    { staffProfileId: 'rbt-1', role: 'RBT', status: 'ACTIVE' },
  ];
  assert.doesNotThrow(() => assertAssignedRole(team, 'bcba-1', 'BCBA', 'BCBA_NOT_ASSIGNED'));
  assert.doesNotThrow(() => assertAssignedRole(team, 'rbt-1', 'RBT', 'RBT_NOT_ASSIGNED'));
  // ended assignment is not eligible
  assert.throws(() => assertAssignedRole(team, 'rbt-old', 'RBT', 'RBT_NOT_ASSIGNED'), (e) => e.code === 'RBT_NOT_ASSIGNED');
  // no BCBA selected / none assigned
  assert.throws(() => assertAssignedRole(team, null, 'BCBA', 'BCBA_NOT_ASSIGNED'), (e) => e.code === 'BCBA_NOT_ASSIGNED');
  assert.throws(() => assertAssignedRole([], 'x', 'BCBA', 'BCBA_NOT_ASSIGNED'), (e) => e.code === 'BCBA_NOT_ASSIGNED');
});
