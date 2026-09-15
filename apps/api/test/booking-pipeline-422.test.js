import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service.js';
import { AppError } from '../src/common/errors/AppError.js';

/**
 * P0 — the rebuilt booking pipeline, exercised through the REAL service with
 * injected in-memory ports (no DB). Proves:
 *   • a valid request creates and persists exactly one appointment; and
 *   • every unmet precondition returns a STRUCTURED 422 and creates NO
 *     appointment (spec §22 error path — the request always reaches a terminal
 *     state, never a hang).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'child-1';
const BCBA = 'bcba-1';
const RBT = 'rbt-1';
const AUTH_ID = 'svc:auth-1';

function makeService(overrides = {}) {
  const created = [];
  const auth = {
    id: AUTH_ID, clientId: CLIENT, serviceCode: 'ABA', status: 'ACTIVE',
    startDate: '2026-09-02', endDate: '2026-09-10', authorizedUnits: 40, usedUnits: 0,
    ...(overrides.auth ?? {}),
  };
  const deps = {
    // Pinned server clock: new appointments must be today…end of this month.
    clock: { now: () => new Date('2026-09-01T12:00:00Z') },
    repository: {
      findAuthorizationById: async () => (overrides.authNull ? null : auth),
      createAppointmentSimple: async (_t, doc) => { const a = { id: `appt-${created.length + 1}`, ...doc }; created.push(a); return a; },
      findAppointmentById: async () => null,
    },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    clients: { findById: async () => (overrides.clientNull ? null : { id: CLIENT, status: 'ACTIVE' }) },
    assignments: {
      listActiveForClient: async () => overrides.careTeam ?? [
        { staffProfileId: BCBA, role: 'BCBA', status: 'ACTIVE' },
        { staffProfileId: RBT, role: 'RBT', status: 'ACTIVE' },
      ],
    },
  };
  return { service: new SchedulingService(deps), created };
}

// One clinician per appointment (spec §4) — RBT-only baseline.
const goodInput = {
  clientId: CLIENT, rbtId: RBT, authorizationIds: [AUTH_ID],
  startDate: '2026-09-10', endDate: '2026-09-10', startTime: '15:00', units: 4,
};

async function expect422(fn, code) {
  await assert.rejects(fn, (err) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${err?.constructor?.name}`);
    assert.equal(err.status, 422, `expected 422, got ${err.status}`);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

test('a valid booking succeeds and persists exactly one appointment', async () => {
  const { service, created } = makeService();
  const appt = await service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: goodInput });
  assert.equal(appt.clientId, CLIENT);
  assert.equal(appt.rbtId, RBT);
  assert.equal(appt.bcbaId ?? null, null, 'an RBT-only appointment has no BCBA');
  assert.equal(appt.units, 4);
  assert.equal(appt.status, 'SCHEDULED');
  assert.equal(created.length, 1);
});

test('naming BOTH a BCBA and an RBT → 422 MULTIPLE_CLINICIANS, no appointment', async () => {
  const { service, created } = makeService();
  await expect422(() => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...goodInput, bcbaId: BCBA } }), 'MULTIPLE_CLINICIANS');
  assert.equal(created.length, 0);
});

test('wrong-child authorization → 422 AUTHORIZATION_INVALID, no appointment', async () => {
  const { service, created } = makeService({ auth: { clientId: 'someone-else' } });
  await expect422(() => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: goodInput }), 'AUTHORIZATION_INVALID');
  assert.equal(created.length, 0);
});

test('a PENDING / non-bookable authorization is rejected server-side → 422 AUTHORIZATION_INVALID, no appointment', async () => {
  const { service, created } = makeService({ auth: { status: 'PENDING' } });
  await expect422(() => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: goodInput }), 'AUTHORIZATION_INVALID');
  assert.equal(created.length, 0);
});

test('missing authorization → 422 NO_AUTHORIZATION, no appointment', async () => {
  const { service, created } = makeService();
  await expect422(() => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...goodInput, authorizationIds: [] } }), 'NO_AUTHORIZATION');
  assert.equal(created.length, 0);
});

test('unassigned BCBA → 422 BCBA_NOT_ASSIGNED, no appointment', async () => {
  const { service, created } = makeService({ careTeam: [{ staffProfileId: RBT, role: 'RBT', status: 'ACTIVE' }] });
  await expect422(() => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...goodInput, rbtId: undefined, bcbaId: BCBA } }), 'BCBA_NOT_ASSIGNED');
  assert.equal(created.length, 0);
});

test('unassigned RBT → 422 RBT_NOT_ASSIGNED, no appointment', async () => {
  const { service, created } = makeService({ careTeam: [{ staffProfileId: BCBA, role: 'BCBA', status: 'ACTIVE' }] });
  await expect422(() => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: goodInput }), 'RBT_NOT_ASSIGNED');
  assert.equal(created.length, 0);
});

test('non-positive units → 422 UNITS_INVALID, no appointment', async () => {
  const { service, created } = makeService();
  await expect422(() => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: { ...goodInput, units: 0 } }), 'UNITS_INVALID');
  assert.equal(created.length, 0);
});

test('end before start → 422 END_BEFORE_START, no appointment', async () => {
  const { service, created } = makeService();
  const bad = { ...goodInput, startTime: '15:00', endTime: '14:00', endDate: '2026-09-10' };
  await expect422(() => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: bad }), 'END_BEFORE_START');
  assert.equal(created.length, 0);
});

test('cross-tenant / unknown client → 422 CLIENT_NOT_FOUND, no appointment', async () => {
  const { service, created } = makeService({ clientNull: true });
  await expect422(() => service.bookAppointment({ tenantId: TENANT, actorUserId: 'u1', input: goodInput }), 'CLIENT_NOT_FOUND');
  assert.equal(created.length, 0);
});
