import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTimeRange,
  defaultUnits,
  overlaps,
  isWithinAvailability,
  validateAuthorization,
  assertClientBookable,
  assertStaffEligible,
} from '../src/modules/scheduling/scheduling.rules.js';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service.js';

// --- pure rules ------------------------------------------------------------

test('validateTimeRange rejects end<=start and >1 day, returns duration', () => {
  assert.throws(() => validateTimeRange('2026-08-05T10:00:00Z', '2026-08-05T10:00:00Z'), (e) => e.code === 'INVALID_TIME_RANGE');
  assert.throws(() => validateTimeRange('2026-08-05T10:00:00Z', '2026-08-06T11:00:00Z'), (e) => e.code === 'INVALID_TIME_RANGE');
  assert.equal(validateTimeRange('2026-08-05T10:00:00Z', '2026-08-05T11:00:00Z'), 60);
});

test('defaultUnits is one per 15 minutes, at least one', () => {
  assert.equal(defaultUnits(60), 4);
  assert.equal(defaultUnits(15), 1);
  assert.equal(defaultUnits(5), 1);
});

test('overlaps detects half-open interval overlap', () => {
  const d = (s) => new Date(s);
  assert.equal(overlaps(d('2026-08-05T10:00Z'), d('2026-08-05T11:00Z'), d('2026-08-05T10:30Z'), d('2026-08-05T11:30Z')), true);
  assert.equal(overlaps(d('2026-08-05T10:00Z'), d('2026-08-05T11:00Z'), d('2026-08-05T11:00Z'), d('2026-08-05T12:00Z')), false);
});

test('isWithinAvailability matches weekday + minute window', () => {
  // 2026-08-05 is a Wednesday (UTC) → dayOfWeek 3
  const windows = [{ dayOfWeek: 3, startMinute: 540, endMinute: 1020, effectiveFrom: null, effectiveTo: null }]; // 09:00–17:00
  assert.equal(isWithinAvailability('2026-08-05T10:00:00Z', '2026-08-05T11:00:00Z', windows), true);
  assert.equal(isWithinAvailability('2026-08-05T08:00:00Z', '2026-08-05T09:30:00Z', windows), false); // before open
  assert.equal(isWithinAvailability('2026-08-06T10:00:00Z', '2026-08-06T11:00:00Z', windows), false); // Thursday
  assert.equal(isWithinAvailability('2026-08-05T10:00:00Z', '2026-08-05T11:00:00Z', []), false); // none defined
});

test('validateAuthorization enforces client, status, dates, units', () => {
  const base = { clientId: 'c-1', status: 'ACTIVE', startDate: '2026-08-01', endDate: '2026-08-31', authorizedUnits: 10, usedUnits: 6 };
  const win = { clientId: 'c-1', startAt: new Date('2026-08-05T10:00Z'), endAt: new Date('2026-08-05T11:00Z'), units: 4 };
  assert.doesNotThrow(() => validateAuthorization(base, win));
  assert.throws(() => validateAuthorization({ ...base, clientId: 'other' }, win), (e) => e.code === 'AUTHORIZATION_INVALID');
  assert.throws(() => validateAuthorization({ ...base, status: 'REVOKED' }, win), (e) => e.code === 'AUTHORIZATION_INVALID');
  assert.throws(() => validateAuthorization({ ...base, endDate: '2026-08-04' }, win), (e) => e.code === 'AUTHORIZATION_INVALID');
  assert.throws(() => validateAuthorization(base, { ...win, units: 5 }), (e) => e.code === 'AUTHORIZATION_EXHAUSTED');
});

test('client bookable + staff eligibility guards', () => {
  assert.throws(() => assertClientBookable({ status: 'ARCHIVED' }), (e) => e.code === 'CLIENT_NOT_BOOKABLE');
  assert.doesNotThrow(() => assertClientBookable({ status: 'ACTIVE' }));
  assert.throws(() => assertStaffEligible({ status: 'INACTIVE' }, [{ status: 'ACTIVE' }]), (e) => e.code === 'STAFF_NOT_ELIGIBLE');
  assert.throws(() => assertStaffEligible({ status: 'ACTIVE' }, []), (e) => e.code === 'STAFF_NOT_ELIGIBLE');
  assert.doesNotThrow(() => assertStaffEligible({ status: 'ACTIVE' }, [{ status: 'ACTIVE' }]));
});

// --- service orchestration -------------------------------------------------

/**
 * The rebuilt Book Appointment pipeline (spec §9). makeService wires the REAL
 * SchedulingService over in-memory ports. The default care team has one ACTIVE
 * BCBA and one ACTIVE RBT assigned to the client, and one authorization for the
 * client — the happy path. Overrides exercise each failure branch.
 */
function makeService({ state = 'ACTIVE', over = {} } = {}) {
  const created = [];
  const deltas = [];
  const repo = {
    // still used by updateAppointment (reschedule) — the new create path does not touch these
    listAvailability: async () => [{ dayOfWeek: 3, startMinute: 540, endMinute: 1020, effectiveFrom: null, effectiveTo: null }],
    findAuthorizationById: async () => ({ id: 'a-1', clientId: 'c-1', status: 'ACTIVE', startDate: '2026-08-01', endDate: '2026-08-31', authorizedUnits: 100, usedUnits: 0, serviceCode: '97153' }),
    findOverlaps: async () => [],
    // new simple create
    createAppointmentSimple: async (_t, doc) => { created.push(doc); return { id: 'ap-1', ...doc, version: 1 }; },
    // legacy create (kept for series); should NOT be called by the new pipeline
    createAppointment: async (_t, doc) => { created.push({ ...doc, __legacy: true }); return { id: 'ap-legacy', ...doc, version: 1 }; },
    findAppointmentById: async () => ({ id: 'ap-1', clientId: 'c-1', staffProfileId: 'rbt-1', authorizationId: 'a-1', startAt: new Date('2026-08-05T10:00:00Z'), endAt: new Date('2026-08-05T11:00:00Z'), units: 4, status: 'SCHEDULED', version: 1 }),
    updateAppointment: async (_t, id, patch, v, extra) => { deltas.push(extra); return { id, ...patch, version: v + 1 }; },
    cancelAppointment: async (_t, id) => ({ id, status: 'CANCELLED' }),
    listAppointments: async () => ({ items: [], nextCursor: null }),
    listAuthorizations: async () => ({ items: [], nextCursor: null }),
    createAuthorization: async (_t, doc) => ({ id: 'a-9', ...doc, version: 1 }),
    updateAuthorization: async (_t, id, patch, v) => ({ id, ...patch, version: v + 1 }),
    ...over.repo,
  };
  const service = new SchedulingService({
    repository: repo,
    // Pinned server clock: new appointments must be today…end of this month.
    clock: { now: () => new Date('2026-08-01T12:00:00Z') },
    // The new create path does not call the insurance gate; kept only for series/update.
    insuranceGate: over.insuranceGate ?? { assertVerified: async () => ({ satisfied: true }) },
    ...(over.assignmentGate ? { assignmentGate: over.assignmentGate } : {}),
    organizations: { getById: async () => ({ state }) },
    clients: { findById: async () => ({ id: 'c-1', status: 'ACTIVE' }), ...over.clients },
    // care-team assignments the new pipeline validates BCBA/RBT against
    assignments: {
      listActiveForClient: async () => [
        { staffProfileId: 'bcba-1', role: 'BCBA', status: 'ACTIVE' },
        { staffProfileId: 'rbt-1', role: 'RBT', status: 'ACTIVE' },
      ],
      ...over.assignments,
    },
    staff: {
      findById: async () => ({ id: 'rbt-1', status: 'ACTIVE' }),
      listCredentials: async () => [{ status: 'ACTIVE' }],
      ...over.staff,
    },
  });
  return { service, created, deltas };
}

// New canonical booking request: ONE clinician per appointment (spec §4) — RBT-only.
const goodBooking = {
  clientId: 'c-1', rbtId: 'rbt-1', authorizationIds: ['a-1'],
  startDate: '2026-08-05', endDate: '2026-08-05', startTime: '10:00', units: 4,
};

test('booking is refused (409) when org is not ACTIVE', async () => {
  const { service } = makeService({ state: 'SUSPENDED' });
  await assert.rejects(() => service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: goodBooking }), (e) => e.code === 'ORG_NOT_ACTIVE');
});

test('a valid RBT-only booking persists the RBT as staffProfileId (no BCBA), records the authorization, inherits serviceCode', async () => {
  const { service, created } = makeService();
  const appt = await service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: goodBooking });
  assert.equal(created.length, 1);
  assert.ok(!created[0].__legacy, 'the new simple create path is used, not the legacy transactional one');
  assert.equal(appt.status, 'SCHEDULED');
  assert.equal(appt.units, 4);
  assert.equal(created[0].staffProfileId, 'rbt-1', 'RBT is the delivering staff (Sessions/Billing/Payroll compat)');
  assert.equal(created[0].bcbaId ?? null, null, 'an RBT-only appointment carries no BCBA');
  assert.equal(created[0].rbtId, 'rbt-1');
  assert.deepEqual(created[0].authorizationIds, ['a-1']);
  assert.equal(created[0].authorizationId, 'a-1', 'primary authorization is the first selected');
  assert.equal(created[0].serviceCode, '97153', 'inherited from the primary authorization');
  assert.equal(created[0].createdBy, 'u');
});

test('booking refused (422 MULTIPLE_CLINICIANS) when both a BCBA and an RBT are named on one appointment', async () => {
  const { service, created } = makeService();
  await assert.rejects(
    () => service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: { ...goodBooking, bcbaId: 'bcba-1' } }),
    (e) => e.code === 'MULTIPLE_CLINICIANS' && e.status === 422,
  );
  assert.equal(created.length, 0);
});

test('multiple authorizations are all stored; the first is primary', async () => {
  const byId = {
    'a-1': { id: 'a-1', clientId: 'c-1', status: 'ACTIVE', serviceCode: 'ABA' },
    'a-2': { id: 'a-2', clientId: 'c-1', status: 'ACTIVE', serviceCode: 'FBA' },
  };
  const { service, created } = makeService({ over: { repo: { findAuthorizationById: async (_t, id) => byId[id] ?? null } } });
  await service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: { ...goodBooking, authorizationIds: ['a-1', 'a-2'] } });
  assert.deepEqual(created[0].authorizationIds, ['a-1', 'a-2']);
  assert.equal(created[0].authorizationId, 'a-1');
});

test('booking refused when the chosen BCBA is not an active care-team member', async () => {
  const { service, created } = makeService({ over: { assignments: { listActiveForClient: async () => [{ staffProfileId: 'rbt-1', role: 'RBT', status: 'ACTIVE' }] } } });
  await assert.rejects(() => service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: { ...goodBooking, rbtId: undefined, bcbaId: 'bcba-1' } }), (e) => e.code === 'BCBA_NOT_ASSIGNED');
  assert.equal(created.length, 0);
});

test('booking refused when the chosen RBT is not an active care-team member', async () => {
  const { service, created } = makeService({ over: { assignments: { listActiveForClient: async () => [{ staffProfileId: 'bcba-1', role: 'BCBA', status: 'ACTIVE' }] } } });
  await assert.rejects(() => service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: goodBooking }), (e) => e.code === 'RBT_NOT_ASSIGNED');
  assert.equal(created.length, 0);
});

test('booking refused when no authorization is selected', async () => {
  const { service, created } = makeService();
  await assert.rejects(() => service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: { ...goodBooking, authorizationIds: [] } }), (e) => e.code === 'NO_AUTHORIZATION');
  assert.equal(created.length, 0);
});

test('booking refused when a selected authorization belongs to a different child (tenant/child guard)', async () => {
  const { service, created } = makeService({ over: { repo: { findAuthorizationById: async () => ({ id: 'a-1', clientId: 'someone-else', status: 'ACTIVE' }) } } });
  await assert.rejects(() => service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: goodBooking }), (e) => e.code === 'AUTHORIZATION_INVALID');
  assert.equal(created.length, 0);
});

test('booking refused when units are missing or not > 0', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: { ...goodBooking, units: 0 } }), (e) => e.code === 'UNITS_INVALID');
  await assert.rejects(() => service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: { ...goodBooking, units: -3 } }), (e) => e.code === 'UNITS_INVALID');
});

test('booking refused when a cross-tenant / archived client cannot be resolved', async () => {
  const missing = makeService({ over: { clients: { findById: async () => null } } });
  await assert.rejects(() => missing.service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: goodBooking }), (e) => e.code === 'CLIENT_NOT_FOUND');
  const archived = makeService({ over: { clients: { findById: async () => ({ id: 'c-1', status: 'ARCHIVED' }) } } });
  await assert.rejects(() => archived.service.bookAppointment({ tenantId: 't', actorUserId: 'u', input: goodBooking }), (e) => e.code === 'CLIENT_NOT_BOOKABLE');
});

test('reschedule re-validates and computes the unit delta for burn-down', async () => {
  const { service, deltas } = makeService();
  // current units=4; new 30-min slot → 2 units → delta -2
  await service.updateAppointment({ tenantId: 't', appointmentId: 'ap-1', actorUserId: 'u', expectedVersion: 1, input: { startAt: '2026-08-05T10:00:00Z', endAt: '2026-08-05T10:30:00Z' } });
  assert.equal(deltas[0].unitDelta, -2);
  assert.equal(deltas[0].authorizationId, 'a-1');
});

test('createAuthorization requires the client to exist', async () => {
  const { service } = makeService({ over: { clients: { findById: async () => null } } });
  await assert.rejects(
    () => service.createAuthorization({ tenantId: 't', actorUserId: 'u', input: { clientId: 'missing', startDate: '2026-08-01', endDate: '2026-08-31', authorizedUnits: 10 } }),
    (e) => e.code === 'CLIENT_NOT_BOOKABLE',
  );
});
