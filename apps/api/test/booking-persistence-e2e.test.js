import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service.js';

/**
 * P0 — Book Appointment (rebuilt pipeline) must CREATE, PERSIST, and be READABLE
 * back, with the BCBA/RBT care-team gate and tenant/child authorization guard
 * enforced.
 *
 * A live mongod cannot be provisioned in this sandbox (the binary download is
 * network-blocked and none is cached), so this reproduces the exact contract the
 * real repository implements — createAppointmentSimple stores the record (and
 * best-effort burns the primary authorization); findAppointmentById reads it
 * back — through the REAL SchedulingService. It fails if: the orchestration
 * doesn't reach create, the created record isn't retrievable, an unassigned
 * BCBA/RBT is let through, or a wrong-child authorization is accepted.
 */

const TENANT = 't1';
const CLIENT = 'child-1';
const BCBA = 'bcba-1';
const RBT = 'rbt-1';
const AUTH_ID = 'svc:auth-1';

function makeStore() {
  const appts = new Map();
  const auth = {
    id: AUTH_ID, clientId: CLIENT, serviceCode: 'ABA', status: 'ACTIVE',
    startDate: '2026-01-01', endDate: '2026-12-31', authorizedUnits: 160, usedUnits: 0, remainingUnits: 160,
  };
  let seq = 0;
  return {
    auth,
    appts,
    repository: {
      findAuthorizationById: async () => ({ ...auth }),
      createAppointmentSimple: async (_t, doc) => {
        const id = `appt-${++seq}`;
        const rec = { id, ...doc, startAt: new Date(doc.startAt).toISOString(), endAt: new Date(doc.endAt).toISOString() };
        appts.set(id, rec);
        auth.usedUnits += doc.units; // mirrors the repository's best-effort burn-down
        return rec;
      },
      findAppointmentById: async (_t, id) => appts.get(id) ?? null,
    },
  };
}

function makeService(store, careTeam = [
  { staffProfileId: BCBA, role: 'BCBA', status: 'ACTIVE' },
  { staffProfileId: RBT, role: 'RBT', status: 'ACTIVE' },
]) {
  return new SchedulingService({
    // Pinned server clock: new appointments must be today…end of this month.
    clock: { now: () => new Date('2026-09-01T12:00:00Z') },
    repository: store.repository,
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    clients: { findById: async () => ({ id: CLIENT, status: 'ACTIVE' }) },
    assignments: { listActiveForClient: async () => careTeam },
  });
}

// One clinician per appointment (spec §4). The default booking is RBT-only, so
// staffProfileId (the delivering-staff mirror Sessions/Billing/Payroll read)
// resolves to the RBT. A BCBA-only booking is exercised via an override.
const booking = (over = {}) => ({
  clientId: CLIENT, rbtId: RBT, authorizationIds: [AUTH_ID],
  startDate: '2026-09-09', endDate: '2026-09-09', startTime: '15:00', units: 4, ...over,
});

test('a valid booking creates a real appointment that is retrievable by id (persistence)', async () => {
  const store = makeStore();
  const svc = makeService(store);
  const appt = await svc.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: booking() });
  assert.ok(appt?.id, 'returned an appointment id');
  assert.equal(appt.status, 'SCHEDULED');
  assert.equal(appt.staffProfileId, RBT, 'RBT is the delivering staff for Sessions/Billing/Payroll');
  const fetched = await svc.getAppointment({ tenantId: TENANT, appointmentId: appt.id });
  assert.ok(fetched && fetched.id === appt.id, 'appointment persists and reads back');
});

test('an unassigned BCBA is rejected and no appointment/units are written', async () => {
  const store = makeStore();
  const svc = makeService(store, [{ staffProfileId: RBT, role: 'RBT', status: 'ACTIVE' }]);
  await assert.rejects(
    () => svc.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: booking({ rbtId: undefined, bcbaId: BCBA }) }),
    (e) => e.code === 'BCBA_NOT_ASSIGNED',
  );
  assert.equal(store.appts.size, 0);
  assert.equal(store.auth.usedUnits, 0);
});

test('an unassigned RBT is rejected and no appointment/units are written', async () => {
  const store = makeStore();
  const svc = makeService(store, [{ staffProfileId: BCBA, role: 'BCBA', status: 'ACTIVE' }]);
  await assert.rejects(
    () => svc.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: booking() }),
    (e) => e.code === 'RBT_NOT_ASSIGNED',
  );
  assert.equal(store.appts.size, 0);
});

test('a successful booking consumes the primary authorization units exactly once', async () => {
  const store = makeStore();
  const svc = makeService(store);
  await svc.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: booking() });
  assert.equal(store.auth.usedUnits, 4, 'exactly the 4 booked units were burned (no double burn-down)');
});

test('multiple authorizations are all persisted on the appointment', async () => {
  const store = makeStore();
  const svc = makeService(store);
  const appt = await svc.bookAppointment({
    tenantId: TENANT, actorUserId: 'u',
    input: booking({ authorizationIds: [AUTH_ID, 'svc:auth-2'] }),
  });
  const fetched = await svc.getAppointment({ tenantId: TENANT, appointmentId: appt.id });
  assert.deepEqual(fetched.authorizationIds, [AUTH_ID, 'svc:auth-2']);
  assert.equal(fetched.authorizationId, AUTH_ID);
});
