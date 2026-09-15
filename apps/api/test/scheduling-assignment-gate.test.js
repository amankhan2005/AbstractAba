import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAssignmentGate } from '../src/modules/scheduling/scheduling.service.js';

const team = [
  { staffProfileId: 'sp-assigned', role: 'RBT', status: 'ACTIVE' },
  { staffProfileId: 'sp-ended', role: 'RBT', status: 'ENDED' },
];
const assignmentsPort = { listActiveForClient: async () => team };

test('disabled gate is a pass-through (existing behaviour preserved)', async () => {
  const gate = makeAssignmentGate({ assignments: assignmentsPort, enabled: false });
  // even a totally unassigned staff passes when the gate is off
  await gate.assertAssigned({ tenantId: 't', clientId: 'c1', staffProfileId: 'sp-stranger' });
});

test('enabled gate allows a staff member with an ACTIVE assignment', async () => {
  const gate = makeAssignmentGate({ assignments: assignmentsPort, enabled: true });
  await gate.assertAssigned({ tenantId: 't', clientId: 'c1', staffProfileId: 'sp-assigned' });
});

test('enabled gate rejects a staff member not on the care team', async () => {
  const gate = makeAssignmentGate({ assignments: assignmentsPort, enabled: true });
  await assert.rejects(
    () => gate.assertAssigned({ tenantId: 't', clientId: 'c1', staffProfileId: 'sp-stranger' }),
    (e) => e.code === 'STAFF_NOT_ASSIGNED',
  );
});

test('enabled gate rejects a staff member whose assignment has ENDED', async () => {
  const gate = makeAssignmentGate({ assignments: assignmentsPort, enabled: true });
  await assert.rejects(
    () => gate.assertAssigned({ tenantId: 't', clientId: 'c1', staffProfileId: 'sp-ended' }),
    (e) => e.code === 'STAFF_NOT_ASSIGNED',
  );
});
