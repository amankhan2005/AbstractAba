import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service.js';
import { AppError } from '../src/common/errors/AppError.js';

/**
 * Spec §4/§5/§17/§23 — the headline invariant of the rebuild:
 *
 *   ONE APPOINTMENT = ONE PRIMARY CLINICIAN = ONE SESSION CONTEXT
 *
 * A NEW appointment names EITHER a BCBA OR an RBT — never both, never neither.
 * When a child needs both roles the admin books TWO separate appointments, and
 * the schedule keeps them as two independent rows. This proves the WRITE-path
 * guard through the REAL SchedulingService with in-memory ports (no DB); the
 * per-clinician session independence that flows from it is proven in
 * bcba-session / rbt-session / independent-hours / session-detail-role-isolation.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'child-HY';
const BCBA = 'bcba-jackie';
const RBT = 'rbt-testk';
const AUTH_ID = 'svc:auth-shared';

function makeService() {
  const created = [];
  const auth = { id: AUTH_ID, clientId: CLIENT, serviceCode: 'ABA', status: 'ACTIVE', startDate: '2026-09-01', endDate: '2026-09-30', authorizedUnits: 400, usedUnits: 0 };
  const deps = {
    // Pinned server clock: new appointments must be today…end of this month.
    clock: { now: () => new Date('2026-09-01T12:00:00Z') },
    repository: {
      findAuthorizationById: async () => auth,
      createAppointmentSimple: async (_t, doc) => { const a = { id: `appt-${created.length + 1}`, ...doc }; created.push(a); return a; },
      findAppointmentById: async (_t, id) => created.find((a) => a.id === id) ?? null,
    },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    clients: { findById: async () => ({ id: CLIENT, status: 'ACTIVE' }) },
    assignments: {
      listActiveForClient: async () => [
        { staffProfileId: BCBA, role: 'BCBA', status: 'ACTIVE' },
        { staffProfileId: RBT, role: 'RBT', status: 'ACTIVE' },
      ],
    },
  };
  return { service: new SchedulingService(deps), created };
}

// H Y, 09/08/2026 — the two windows from the spec's target architecture.
const bcbaWindow = { clientId: CLIENT, authorizationIds: [AUTH_ID], startDate: '2026-09-08', endDate: '2026-09-08', startTime: '10:00', endTime: '11:30', units: 6 };
const rbtWindow = { clientId: CLIENT, authorizationIds: [AUTH_ID], startDate: '2026-09-08', endDate: '2026-09-08', startTime: '10:15', endTime: '12:45', units: 10 };

// TEST 1 — a BCBA appointment carries the BCBA and no RBT.
test('TEST 1 — BCBA appointment: bcbaId set, rbtId null', async () => {
  const { service } = makeService();
  const appt = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: { ...bcbaWindow, bcbaId: BCBA } });
  assert.equal(appt.bcbaId, BCBA);
  assert.equal(appt.rbtId ?? null, null);
  assert.equal(appt.staffProfileId, BCBA, 'the single clinician is the delivering staff');
});

// TEST 2 — an RBT appointment carries the RBT and no BCBA.
test('TEST 2 — RBT appointment: rbtId set, bcbaId null', async () => {
  const { service } = makeService();
  const appt = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: { ...rbtWindow, rbtId: RBT } });
  assert.equal(appt.rbtId, RBT);
  assert.equal(appt.bcbaId ?? null, null);
  assert.equal(appt.staffProfileId, RBT);
});

// TEST 3 / TEST 8 — same child, both roles, overlapping windows → TWO
// independent appointments. A single request naming both is refused.
test('TEST 3 — same child + BCBA + RBT → TWO separate appointments (overlap allowed)', async () => {
  const { service, created } = makeService();
  const a = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: { ...bcbaWindow, bcbaId: BCBA } });
  const b = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: { ...rbtWindow, rbtId: RBT } });
  assert.notEqual(a.id, b.id, 'two distinct appointment rows');
  assert.equal(created.length, 2);
  assert.equal(a.bcbaId, BCBA); assert.equal(a.rbtId ?? null, null);
  assert.equal(b.rbtId, RBT); assert.equal(b.bcbaId ?? null, null);
  // They legitimately share client + authorization but nothing lifecycle-bound.
  assert.equal(a.clientId, b.clientId);
  assert.deepEqual(a.authorizationIds, b.authorizationIds);
});

test('a single appointment naming BOTH clinicians is refused (422 MULTIPLE_CLINICIANS)', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    () => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: { ...bcbaWindow, bcbaId: BCBA, rbtId: RBT } }),
    (e) => { assert.ok(e instanceof AppError); assert.equal(e.status, 422); assert.equal(e.code, 'MULTIPLE_CLINICIANS'); return true; },
  );
  assert.equal(created.length, 0);
});

test('an appointment naming NEITHER clinician is refused (422 NO_CLINICIAN)', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    () => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u', input: { ...bcbaWindow } }),
    (e) => { assert.ok(e instanceof AppError); assert.equal(e.status, 422); assert.equal(e.code, 'NO_CLINICIAN'); return true; },
  );
  assert.equal(created.length, 0);
});
