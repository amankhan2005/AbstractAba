import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeToAssignedClinician } from '../src/modules/rbac/scopeFilters.js';

/**
 * Spec §6/§7 — calendars/appointment lists are scoped by clinician ASSIGNMENT
 * (bcbaId / rbtId), never by client caseload or the mirrored delivering staff.
 * A clinician sees only appointments they are assigned to; admins see all.
 */

// The Part-6 matrix (H).
const APPTS = [
  { id: 'A', bcbaId: 'bcba-1', rbtId: 'rbt-1' },
  { id: 'B', bcbaId: 'bcba-1', rbtId: null },
  { id: 'C', bcbaId: null, rbtId: 'rbt-1' },
  { id: 'D', bcbaId: 'bcba-2', rbtId: 'rbt-2' },
];

// Minimal evaluator for the filter shapes scopeToAssignedClinician produces.
function matches(filter, appt) {
  if (filter._id && Array.isArray(filter._id.$in) && filter._id.$in.length === 0) return false; // IMPOSSIBLE
  if (!filter.$and) return true; // unrestricted
  return filter.$and.every((cond) => {
    if (cond.$or) return cond.$or.some((c) => Object.entries(c).every(([k, v]) => appt[k] === v));
    return true;
  });
}
const visible = (dataScope) => {
  const filter = {};
  scopeToAssignedClinician(filter, dataScope);
  return APPTS.filter((a) => matches(filter, a)).map((a) => a.id);
};

const clinician = (staffProfileId) => ({ scope: 'SELF', staffProfileId, clientIds: ['child-1'], staffIds: [staffProfileId] });
const ADMIN = { scope: 'ORGANIZATION', staffProfileId: null, clientIds: null, staffIds: null };

test('BCBA-1 calendar shows only their assigned appointments (A, B)', () => {
  assert.deepEqual(visible(clinician('bcba-1')).sort(), ['A', 'B']);
});
test('RBT-1 calendar shows only their assigned appointments (A, C)', () => {
  assert.deepEqual(visible(clinician('rbt-1')).sort(), ['A', 'C']);
});
test('BCBA-2 / RBT-2 see only their own (D), never another clinician\'s', () => {
  assert.deepEqual(visible(clinician('bcba-2')).sort(), ['D']);
  assert.deepEqual(visible(clinician('rbt-2')).sort(), ['D']);
});
test('a tenant-wide admin/scheduler sees the whole clinic', () => {
  assert.deepEqual(visible(ADMIN).sort(), ['A', 'B', 'C', 'D']);
});
test('a restricted principal with no staff profile sees nothing (fail closed)', () => {
  assert.deepEqual(visible({ scope: 'SELF', staffProfileId: null, clientIds: [], staffIds: [] }), []);
});
test('no dataScope at all → fail closed (IMPOSSIBLE)', () => {
  const filter = {};
  scopeToAssignedClinician(filter, null);
  assert.deepEqual(filter._id, { $in: [] });
});
test('produces bcbaId/rbtId $or (not caseload/childId) for a clinician', () => {
  const filter = {};
  scopeToAssignedClinician(filter, clinician('bcba-1'));
  assert.ok(filter.$and?.[0]?.$or, 'expected an $or clause');
  assert.deepEqual(filter.$and[0].$or, [{ bcbaId: 'bcba-1' }, { rbtId: 'bcba-1' }]);
});
