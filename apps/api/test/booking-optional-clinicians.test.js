import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service.js';
import { AppError } from '../src/common/errors/AppError.js';

/**
 * Spec §4/§17/§23 — ONE appointment names exactly ONE clinician: a booking is
 * either BCBA-only or RBT-only. Neither is rejected (NO_CLINICIAN); both is
 * rejected (MULTIPLE_CLINICIANS). To schedule both roles for a child, two
 * separate appointments are created. Exercised through the REAL service with
 * in-memory ports (no DB), and the request schema is checked directly.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'child-1';
const BCBA = 'bcba-1';
const RBT = 'rbt-1';
const AUTH_ID = 'svc:auth-1';

function makeService() {
  const created = [];
  const auth = { id: AUTH_ID, clientId: CLIENT, serviceCode: 'ABA', status: 'ACTIVE', startDate: '2026-09-02', endDate: '2026-09-30', authorizedUnits: 40, usedUnits: 0 };
  const deps = {
    // Pinned server clock: new appointments must be today…end of this month.
    clock: { now: () => new Date('2026-09-01T12:00:00Z') },
    repository: {
      findAuthorizationById: async () => auth,
      createAppointmentSimple: async (_t, doc) => { const a = { id: `appt-${created.length + 1}`, ...doc }; created.push(a); return a; },
      findAppointmentById: async () => null,
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
const base = { clientId: CLIENT, authorizationIds: [AUTH_ID], startDate: '2026-09-10', endDate: '2026-09-10', startTime: '15:00', units: 4 };

test('BCBA-only booking succeeds (no RBT)', async () => {
  const { service, created } = makeService();
  const appt = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...base, bcbaId: BCBA } });
  assert.equal(appt.bcbaId, BCBA);
  assert.equal(appt.rbtId ?? null, null);
  assert.equal(created.length, 1);
});

test('RBT-only booking succeeds (no BCBA)', async () => {
  const { service, created } = makeService();
  const appt = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...base, rbtId: RBT } });
  assert.equal(appt.rbtId, RBT);
  assert.equal(appt.bcbaId ?? null, null);
  assert.equal(created.length, 1);
});

test('BCBA + RBT in ONE booking → 422 MULTIPLE_CLINICIANS, no appointment (spec §4/§17)', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    () => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...base, bcbaId: BCBA, rbtId: RBT } }),
    (err) => { assert.ok(err instanceof AppError); assert.equal(err.status, 422); assert.equal(err.code, 'MULTIPLE_CLINICIANS'); return true; },
  );
  assert.equal(created.length, 0, 'no appointment is created for a two-clinician request');
});

test('neither clinician → 422 NO_CLINICIAN, no appointment', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    () => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...base } }),
    (err) => { assert.ok(err instanceof AppError); assert.equal(err.status, 422); assert.equal(err.code, 'NO_CLINICIAN'); return true; },
  );
  assert.equal(created.length, 0);
});

test('no startTime → date-only booking: timeSet=false, anchored to the day, end from units', async () => {
  const { service, created } = makeService();
  const { startTime, ...noTime } = base;
  const appt = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...noTime, bcbaId: BCBA } });
  assert.equal(created.length, 1);
  assert.equal(appt.timeSet, false, 'a timeless booking is date-only (timeSet=false)');
  assert.ok(appt.startAt instanceof Date);
  assert.ok(appt.endAt.getTime() > appt.startAt.getTime());
});

test('with a startTime → timeSet=true (a real clock time was entered)', async () => {
  const { service } = makeService();
  const appt = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...base, bcbaId: BCBA } });
  assert.equal(appt.timeSet, true);
});

// --- schema contract (route validation layer) -----------------------------
import { createAppointmentSchema } from '../src/modules/scheduling/scheduling.schemas.js';

const CLIENT_UUID = '22222222-2222-4222-8222-222222222222';
const BCBA_UUID = '33333333-3333-4333-8333-333333333333';
const RBT_UUID = '44444444-4444-4444-8444-444444444444';
const AUTH_UUID = '55555555-5555-4555-8555-555555555555';
const schemaBase = { clientId: CLIENT_UUID, authorizationIds: [AUTH_UUID], startDate: '2026-09-10', endDate: '2026-09-10', units: 4 };

test('schema: accepts a BCBA-only payload with no startTime', () => {
  const r = createAppointmentSchema.safeParse({ ...schemaBase, bcbaId: BCBA_UUID });
  assert.equal(r.success, true);
});
test('schema: accepts an RBT-only payload', () => {
  const r = createAppointmentSchema.safeParse({ ...schemaBase, rbtId: RBT_UUID });
  assert.equal(r.success, true);
});
test('schema: rejects a payload with neither clinician', () => {
  const r = createAppointmentSchema.safeParse({ ...schemaBase });
  assert.equal(r.success, false);
});
test('schema: rejects a payload naming BOTH a BCBA and an RBT', () => {
  const r = createAppointmentSchema.safeParse({ ...schemaBase, bcbaId: BCBA_UUID, rbtId: RBT_UUID });
  assert.equal(r.success, false);
});
