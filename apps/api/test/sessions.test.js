import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMeasurement, assertMutable, assertFreezable, assertPatchStatus } from '../src/modules/sessions/sessions.rules.js';
import { SessionsService } from '../src/modules/sessions/sessions.service.js';

/**
 * DB-free tests for session capture: the pure measurement/freeze rules, then the
 * service orchestration against fake repository and ports. They lock in the
 * ACTIVE gate, appointment/plan/target validation, the measurement checks, PHI
 * seal-on-write / open-on-detail, version forwarding, and — the headline — the
 * freeze transition and the frozen-session immutability guard across every
 * mutating path.
 */

// --- pure rules ------------------------------------------------------------

test('validateMeasurement: scalar types require a non-negative value', () => {
  assert.deepEqual(validateMeasurement('FREQUENCY', { value: 7 }), { value: 7, numerator: null, denominator: null });
  assert.deepEqual(validateMeasurement('DURATION', { value: 0 }), { value: 0, numerator: null, denominator: null });
  assert.throws(() => validateMeasurement('RATE', { value: -1 }), (e) => e.code === 'INVALID_MEASUREMENT' && e.status === 422);
  assert.throws(() => validateMeasurement('TRIALS_TO_CRITERION', {}), (e) => e.code === 'INVALID_MEASUREMENT');
});

test('validateMeasurement: ratio types require 0<=num<=den and den>0', () => {
  assert.deepEqual(validateMeasurement('PERCENT_CORRECT', { numerator: 8, denominator: 10 }), { value: null, numerator: 8, denominator: 10 });
  assert.throws(() => validateMeasurement('PERCENT_CORRECT', { numerator: 11, denominator: 10 }), (e) => e.code === 'INVALID_MEASUREMENT');
  assert.throws(() => validateMeasurement('INTERVAL', { numerator: 1, denominator: 0 }), (e) => e.code === 'INVALID_MEASUREMENT');
  assert.throws(() => validateMeasurement('PERCENT_CORRECT', { value: 5 }), (e) => e.code === 'INVALID_MEASUREMENT');
});

test('assertMutable throws only for FROZEN; assertFreezable + assertPatchStatus enforce the state machine', () => {
  assert.doesNotThrow(() => assertMutable('DRAFT'));
  assert.doesNotThrow(() => assertMutable('SUBMITTED'));
  assert.throws(() => assertMutable('FROZEN'), (e) => e.code === 'SESSION_FROZEN' && e.status === 409);
  assert.doesNotThrow(() => assertFreezable('SUBMITTED'));
  assert.throws(() => assertFreezable('FROZEN'), (e) => e.code === 'INVALID_STATUS_TRANSITION');
  // A PATCH may no longer change status at all. It previously permitted any
  // DRAFT<->SUBMITTED move, which is how submission bypassed the completeness
  // check: the UI's `canSubmit` was the only gate between an incomplete
  // session and a BCBA's review queue. Every transition now has its own
  // endpoint enforcing what that transition requires.
  assert.doesNotThrow(() => assertPatchStatus(undefined));
  for (const status of ['DRAFT', 'SUBMITTED', 'FROZEN', 'IN_PROGRESS', 'RETURNED', 'CANCELLED']) {
    assert.throws(
      () => assertPatchStatus(status),
      (e) => e.code === 'INVALID_STATUS_TRANSITION',
      `PATCH must not be able to set status to ${status}`,
    );
  }
});

// --- service harness -------------------------------------------------------

function makeService({ state = 'ACTIVE', sessionStatus = 'DRAFT', over = {} } = {}) {
  const calls = { createSession: [], updateSession: [], addDataPoint: [], freezeSession: [] };
  const sealed = (v) => (v == null ? v : `sealed(${v})`);
  const opened = (v) => (typeof v === 'string' && v.startsWith('sealed(') ? v.slice(7, -1) : v);
  const repo = {
    createSession: async (_t, doc) => { calls.createSession.push(doc); return { id: 's-1', ...doc, version: 1 }; },
    findSessionById: async () => ({
      id: 's-1', appointmentId: 'ap-1', clientId: 'c-1', staffProfileId: 'st-1', treatmentPlanId: 'p-1',
      status: sessionStatus, sensitive: { narrative: sealed('note') }, version: 3,
    }),
    listSessions: async () => ({ items: [{ id: 's-1', status: sessionStatus }], nextCursor: null }),
    updateSession: async (_t, id, patch, v) => { calls.updateSession.push({ patch, v }); return { id, ...patch, sensitive: { narrative: patch['sensitive.narrative'] ?? sealed('note') }, version: (v ?? 1) + 1 }; },
    freezeSession: async (_t, id, actor) => { calls.freezeSession.push({ id, actor }); return { id, status: 'FROZEN', frozenBy: actor, sensitive: { narrative: sealed('note') }, version: 4 }; },
    listDataPoints: async () => [{ id: 'dp-1', targetId: 't-1', measurementType: 'FREQUENCY', value: 3 }],
    findDataPoint: async (_t, _s, id) => ({ id, sessionId: 's-1', targetId: 't-1', measurementType: 'FREQUENCY', value: 3, numerator: null, denominator: null, version: 2 }),
    addDataPoint: async (_t, sid, input) => { calls.addDataPoint.push({ sid, input }); return { id: 'dp-1', sessionId: sid, ...input }; },
    updateDataPoint: async (_t, _s, id, patch, v) => ({ id, ...patch, version: (v ?? 1) + 1 }),
    removeDataPoint: async (_t, _s, id) => ({ dataPointId: id, removed: true }),
    ...over.repo,
  };
  const service = new SessionsService({
    repository: repo,
    organizations: { getById: async () => ({ state }) },
    appointments: { findById: async () => ({ id: 'ap-1', clientId: 'c-1', staffProfileId: 'st-1', status: 'SCHEDULED', startAt: new Date('2026-08-05T10:00:00Z') }), ...over.appointments },
    plans: {
      findPlanById: async () => ({ id: 'p-1', clientId: 'c-1', status: 'ACTIVE' }),
      findTargetById: async () => ({ id: 't-1', programId: 'pr-1', treatmentPlanId: 'p-1', status: 'ACTIVE', archivedAt: null }),
      ...over.plans,
    },
    phi: { seal: sealed, open: opened },
  });
  return { service, calls };
}

const createInput = { appointmentId: 'ap-1', treatmentPlanId: 'p-1', narrative: 'note' };

// --- ACTIVE gate + creation validation -------------------------------------

test('create refused (409) when org not ACTIVE', async () => {
  const { service } = makeService({ state: 'SUSPENDED' });
  await assert.rejects(() => service.createSession({ tenantId: 't', actorUserId: 'u', input: createInput }), (e) => e.code === 'ORG_NOT_ACTIVE' && e.status === 409);
});

test('create refused (422) when the appointment is missing or cancelled', async () => {
  const missing = makeService({ over: { appointments: { findById: async () => null } } });
  await assert.rejects(() => missing.service.createSession({ tenantId: 't', actorUserId: 'u', input: createInput }), (e) => e.code === 'APPOINTMENT_INVALID' && e.status === 422);
  const cancelled = makeService({ over: { appointments: { findById: async () => ({ id: 'ap-1', clientId: 'c-1', staffProfileId: 'st-1', status: 'CANCELLED' }) } } });
  await assert.rejects(() => cancelled.service.createSession({ tenantId: 't', actorUserId: 'u', input: createInput }), (e) => e.code === 'APPOINTMENT_INVALID');
});

test('create refused (422) when the plan is not ACTIVE or belongs to another client', async () => {
  const draft = makeService({ over: { plans: { findPlanById: async () => ({ id: 'p-1', clientId: 'c-1', status: 'DRAFT' }), findTargetById: async () => null } } });
  await assert.rejects(() => draft.service.createSession({ tenantId: 't', actorUserId: 'u', input: createInput }), (e) => e.code === 'PLAN_INVALID' && e.status === 422);
  const wrongClient = makeService({ over: { plans: { findPlanById: async () => ({ id: 'p-1', clientId: 'other', status: 'ACTIVE' }), findTargetById: async () => null } } });
  await assert.rejects(() => wrongClient.service.createSession({ tenantId: 't', actorUserId: 'u', input: createInput }), (e) => e.code === 'PLAN_INVALID');
});

test('create seals the narrative and takes client/staff from the appointment (not the caller)', async () => {
  const { service, calls } = makeService();
  const result = await service.createSession({ tenantId: 't', actorUserId: 'u', input: createInput });
  const doc = calls.createSession[0];
  assert.equal(doc.clientId, 'c-1');
  assert.equal(doc.staffProfileId, 'st-1');
  assert.equal(doc.status, 'DRAFT');
  assert.equal(doc.sensitive.narrative, 'sealed(note)', 'narrative is sealed before it reaches the repository');
  // the presented result opens the sealed envelope and exposes no `sensitive`
  assert.equal(result.narrative, 'note');
  assert.ok(!('sensitive' in result));
});

test('detail opens the sealed narrative; list carries no sealed envelope', async () => {
  const { service } = makeService();
  const detail = await service.getSession({ tenantId: 't', sessionId: 's-1' });
  assert.equal(detail.session.narrative, 'note');
  assert.ok(!('sensitive' in detail.session));
  assert.equal(detail.dataPoints.length, 1);
});

// --- data points -----------------------------------------------------------

test('add data point validates the target belongs to the plan and is active', async () => {
  const foreign = makeService({ over: { plans: { findPlanById: async () => ({ id: 'p-1', clientId: 'c-1', status: 'ACTIVE' }), findTargetById: async () => ({ id: 't-1', treatmentPlanId: 'OTHER', status: 'ACTIVE', archivedAt: null }) } } });
  await assert.rejects(() => foreign.service.addDataPoint({ tenantId: 't', sessionId: 's-1', actorUserId: 'u', input: { targetId: 't-1', measurementType: 'FREQUENCY', value: 3 } }), (e) => e.code === 'TARGET_INVALID' && e.status === 422);

  const archived = makeService({ over: { plans: { findPlanById: async () => ({ id: 'p-1', clientId: 'c-1', status: 'ACTIVE' }), findTargetById: async () => ({ id: 't-1', treatmentPlanId: 'p-1', status: 'INACTIVE', archivedAt: new Date() }) } } });
  await assert.rejects(() => archived.service.addDataPoint({ tenantId: 't', sessionId: 's-1', actorUserId: 'u', input: { targetId: 't-1', measurementType: 'FREQUENCY', value: 3 } }), (e) => e.code === 'TARGET_INVALID');
});

test('add data point normalises the measurement and denormalises the program + plan', async () => {
  const { service, calls } = makeService();
  await service.addDataPoint({ tenantId: 't', sessionId: 's-1', actorUserId: 'u', input: { targetId: 't-1', measurementType: 'PERCENT_CORRECT', numerator: 8, denominator: 10 } });
  const { input } = calls.addDataPoint[0];
  assert.equal(input.numerator, 8);
  assert.equal(input.denominator, 10);
  assert.equal(input.value, null);
  assert.equal(input.programId, 'pr-1');
  assert.equal(input.treatmentPlanId, 'p-1');
});

test('update data point forwards the optional If-Match version', async () => {
  const { service } = makeService();
  const res = await service.updateDataPoint({ tenantId: 't', sessionId: 's-1', dataPointId: 'dp-1', actorUserId: 'u', expectedVersion: 2, input: { value: 5 } });
  assert.equal(res.version, 3);
});

// --- freeze + immutability -------------------------------------------------

test('freeze transitions a DRAFT/SUBMITTED session to FROZEN with a signer', async () => {
  const { service, calls } = makeService({ sessionStatus: 'SUBMITTED' });
  const res = await service.freezeSession({ tenantId: 't', sessionId: 's-1', actorUserId: 'bcba-9' });
  assert.equal(res.status, 'FROZEN');
  assert.equal(calls.freezeSession[0].actor, 'bcba-9');
});

test('freeze refused when the session is already FROZEN', async () => {
  const { service } = makeService({ sessionStatus: 'FROZEN' });
  await assert.rejects(() => service.freezeSession({ tenantId: 't', sessionId: 's-1', actorUserId: 'u' }), (e) => e.code === 'INVALID_STATUS_TRANSITION' && e.status === 409);
});

test('a FROZEN session is immutable across every mutating path', async () => {
  const { service } = makeService({ sessionStatus: 'FROZEN' });
  await assert.rejects(() => service.updateSession({ tenantId: 't', sessionId: 's-1', actorUserId: 'u', expectedVersion: 3, input: { narrative: 'x' } }), (e) => e.code === 'SESSION_FROZEN');
  await assert.rejects(() => service.addDataPoint({ tenantId: 't', sessionId: 's-1', actorUserId: 'u', input: { targetId: 't-1', measurementType: 'FREQUENCY', value: 1 } }), (e) => e.code === 'SESSION_FROZEN');
  await assert.rejects(() => service.updateDataPoint({ tenantId: 't', sessionId: 's-1', dataPointId: 'dp-1', actorUserId: 'u', input: { value: 1 } }), (e) => e.code === 'SESSION_FROZEN');
  await assert.rejects(() => service.removeDataPoint({ tenantId: 't', sessionId: 's-1', dataPointId: 'dp-1', actorUserId: 'u' }), (e) => e.code === 'SESSION_FROZEN');
});

test('update forwards the version and seals the narrative', async () => {
  const { service, calls } = makeService();
  await service.updateSession({ tenantId: 't', sessionId: 's-1', actorUserId: 'u', expectedVersion: 3, input: { narrative: 'v2' } });
  assert.equal(calls.updateSession[0].v, 3);
  assert.equal(calls.updateSession[0].patch['sensitive.narrative'], 'sealed(v2)');
});

test('REGRESSION — a PATCH can no longer move a session to ANY status', async () => {
  // The bypass: submission used to be `PATCH { status: 'SUBMITTED' }`, which
  // skipped the transition map AND the completeness check, so an incomplete
  // session could land in a BCBA's review queue one approval away from
  // billing. FROZEN was the only value refused.
  const { service } = makeService();
  for (const status of ['SUBMITTED', 'DRAFT', 'FROZEN', 'CANCELLED']) {
    await assert.rejects(
      () => service.updateSession({
        tenantId: 't', sessionId: 's-1', actorUserId: 'u', expectedVersion: 3, input: { status },
      }),
      (e) => e.code === 'INVALID_STATUS_TRANSITION',
      `PATCH to ${status} must be refused`,
    );
  }
});
