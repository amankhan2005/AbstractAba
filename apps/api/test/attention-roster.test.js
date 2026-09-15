import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClientsService } from '../src/modules/clients/clients.service.js';

function makeService(rows) {
  return new ClientsService({
    repository: { listActiveClientsWithAlertState: async () => rows },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    phi: { seal: (x) => x, open: (x) => x },
  });
}

const healthyRow = {
  id: 'c-ok', clientNumber: 'AB-1', firstName: 'Ok', lastName: 'Child',
  intakeWorkflowStatus: 'COMPLETE', approvedWeeklyHours: 30, assignedWeeklyHours: 20,
  careTeam: [{ role: 'BCBA', status: 'ACTIVE' }, { role: 'RBT', status: 'ACTIVE' }],
  serviceAuthorizations: [
    { serviceType: 'FBA', status: 'APPROVED', endDate: '2027-01-01' },
    { serviceType: 'ABA', status: 'APPROVED', endDate: '2027-01-01' },
  ],
};

test('attention roster excludes healthy children and includes those with alerts', async () => {
  const critical = { ...healthyRow, id: 'c-crit', firstName: 'Crit', intakeWorkflowStatus: 'MISSING_DOCUMENTS' };
  const svc = makeService([healthyRow, critical]);
  const out = await svc.getAttentionRoster({ tenantId: 't' });
  assert.equal(out.totalActive, 2);
  assert.equal(out.needsAttention, 1);
  assert.equal(out.children[0].clientId, 'c-crit');
  assert.equal(out.children[0].topSeverity, 'CRITICAL');
});

test('roster is sorted worst-first (CRITICAL before WARNING before INFO)', async () => {
  const warn = { ...healthyRow, id: 'c-warn', careTeam: [{ role: 'RBT', status: 'ACTIVE' }] }; // BCBA missing = WARNING
  const crit = { ...healthyRow, id: 'c-crit', intakeWorkflowStatus: 'MISSING_DOCUMENTS' };
  const info = { ...healthyRow, id: 'c-info', approvedWeeklyHours: 20, assignedWeeklyHours: 19 }; // nearing = INFO
  const svc = makeService([warn, info, crit]);
  const out = await svc.getAttentionRoster({ tenantId: 't' });
  assert.deepEqual(out.children.map((c) => c.clientId), ['c-crit', 'c-warn', 'c-info']);
  assert.deepEqual(out.bySeverity, { CRITICAL: 1, WARNING: 1, INFO: 1 });
});

test('an all-healthy roster reports nobody needing attention', async () => {
  const svc = makeService([healthyRow, { ...healthyRow, id: 'c-2' }]);
  const out = await svc.getAttentionRoster({ tenantId: 't' });
  assert.equal(out.needsAttention, 0);
  assert.deepEqual(out.children, []);
});
