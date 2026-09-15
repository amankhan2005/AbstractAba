import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionsService } from '../src/modules/sessions/sessions.service.js';

/**
 * Admin session oversight (spec §1) needs each session's clinician ROLE so BCBA
 * and RBT rows stay distinct. listSessions derives role from the persisted
 * appointment assignment (staffProfileId === appt.bcbaId → BCBA, === rbtId →
 * RBT) — real assignment, not inference — plus the authoritative workedMinutes.
 */
function makeService(listRows) {
  const appt = { id: 'ap-1', bcbaId: 'bcba-1', rbtId: 'rbt-1', clientId: 'c-1' };
  const tr = { 's-bcba': 90, 's-rbt': 150 };
  return new SessionsService({
    repository: { listSessions: async () => ({ items: listRows, nextCursor: null }) },
    appointments: { findById: async (_t, id) => (id === 'ap-1' ? appt : null) },
    clients: { findById: async (_t, id) => (id === 'c-1' ? { id, firstName: 'John', lastName: 'Smith' } : null) },
    staff: { findById: async (_t, id) => ({ 'bcba-1': { firstName: 'Jane', lastName: 'Smith' }, 'rbt-1': { firstName: 'John', lastName: 'Doe' } }[id] ?? null) },
    timeRecords: { findBySession: async (_t, id) => ({ workedMinutes: tr[id] ?? null }) },
    phi: { open: (v) => v },
  });
}

test('§1 — same appointment yields two rows with distinct roles + independent worked minutes', async () => {
  const rows = [
    { id: 's-bcba', appointmentId: 'ap-1', clientId: 'c-1', staffProfileId: 'bcba-1', status: 'FROZEN' },
    { id: 's-rbt', appointmentId: 'ap-1', clientId: 'c-1', staffProfileId: 'rbt-1', status: 'FROZEN' },
  ];
  const svc = makeService(rows);
  const { items } = await svc.listSessions({ tenantId: 't', clientId: 'c-1' });

  const bcba = items.find((r) => r.id === 's-bcba');
  const rbt = items.find((r) => r.id === 's-rbt');

  assert.equal(bcba.role, 'BCBA');
  assert.equal(rbt.role, 'RBT');
  assert.equal(bcba.clinicianName, 'Jane Smith');
  assert.equal(rbt.clinicianName, 'John Doe');
  assert.equal(bcba.childName, 'John Smith');
  // Independent worked minutes — never combined into 240.
  assert.equal(bcba.workedMinutes, 90);
  assert.equal(rbt.workedMinutes, 150);
  assert.notEqual(bcba.id, rbt.id);
});

test('role is null (not fabricated) when the session has no matching appointment assignment', async () => {
  const svc = makeService([{ id: 's-x', appointmentId: 'ap-1', clientId: 'c-1', staffProfileId: 'other', status: 'FROZEN' }]);
  const { items } = await svc.listSessions({ tenantId: 't', clientId: 'c-1' });
  assert.equal(items[0].role, null);
});
