import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionsService } from '../src/modules/sessions/sessions.service.js';
import { createSessionSchema } from '../src/modules/sessions/sessions.schemas.js';

/**
 * Spec §8/§15/§17 — a session may be created WITHOUT a treatment plan. This is
 * the root-cause fix for the RBT POST /api/v1/sessions 422: the create schema
 * used to hard-require treatmentPlanId (a UUID), and the service used to reject
 * a missing plan with PLAN_INVALID. Both now treat the plan as optional:
 *   • plan present + valid   → session bound to it (Case A)
 *   • plan absent            → session created with treatmentPlanId:null (Case B)
 *   • plan present + invalid → still rejected PLAN_INVALID (no silent drop)
 *   • treatmentPlanId ''     → coerced to absent (the exact 422 an empty UI
 *                              field produced), NOT a UUID-validation failure
 */

const sealed = (v) => (v == null ? v : `sealed(${v})`);
const opened = (v) => (typeof v === 'string' && v.startsWith('sealed(') ? v.slice(7, -1) : v);

function makeService({ plan = { id: 'p-1', clientId: 'c-1', status: 'ACTIVE' }, over = {} } = {}) {
  const calls = { createSession: [] };
  const repo = {
    createSession: async (_t, doc) => { calls.createSession.push(doc); return { id: 's-1', ...doc, version: 1 }; },
    ...over.repo,
  };
  const service = new SessionsService({
    repository: repo,
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    appointments: { findById: async () => ({ id: 'ap-1', clientId: 'c-1', staffProfileId: 'rbt-1', status: 'SCHEDULED', startAt: new Date('2026-09-08T17:30:00Z') }), ...over.appointments },
    plans: { findPlanById: async () => (plan ? { ...plan } : null), findTargetById: async () => null, ...over.plans },
    phi: { seal: sealed, open: opened },
  });
  return { service, calls };
}

// --- schema (route edge) ---------------------------------------------------
const APPT = '11111111-1111-4111-8111-111111111111';
const PLAN = '22222222-2222-4222-8222-222222222222';

test('schema: accepts a create payload with NO treatmentPlanId', () => {
  const r = createSessionSchema.safeParse({ appointmentId: APPT });
  assert.equal(r.success, true);
  assert.equal(r.data.treatmentPlanId, undefined);
});
test('schema: coerces an empty-string treatmentPlanId to absent (the 422 an empty field caused)', () => {
  const r = createSessionSchema.safeParse({ appointmentId: APPT, treatmentPlanId: '' });
  assert.equal(r.success, true);
  assert.equal(r.data.treatmentPlanId, undefined);
});
test('schema: accepts a valid treatmentPlanId UUID', () => {
  const r = createSessionSchema.safeParse({ appointmentId: APPT, treatmentPlanId: PLAN });
  assert.equal(r.success, true);
  assert.equal(r.data.treatmentPlanId, PLAN);
});
test('schema: still rejects a non-UUID treatmentPlanId', () => {
  const r = createSessionSchema.safeParse({ appointmentId: APPT, treatmentPlanId: 'not-a-uuid' });
  assert.equal(r.success, false);
});

// --- service ---------------------------------------------------------------
test('Case A — RBT session WITH a valid plan is bound to that plan', async () => {
  const { service, calls } = makeService();
  const s = await service.createSession({ tenantId: 't', actorUserId: 'u', input: { appointmentId: 'ap-1', treatmentPlanId: 'p-1' } });
  assert.equal(s.treatmentPlanId, 'p-1');
  assert.equal(calls.createSession[0].treatmentPlanId, 'p-1');
});

test('Case B — RBT session WITHOUT a plan succeeds with treatmentPlanId:null (no 422)', async () => {
  const { service, calls } = makeService();
  const s = await service.createSession({ tenantId: 't', actorUserId: 'u', input: { appointmentId: 'ap-1' } });
  assert.equal(s.treatmentPlanId, null);
  assert.equal(calls.createSession[0].treatmentPlanId, null);
  // client + delivering staff are still derived from the appointment, not input.
  assert.equal(calls.createSession[0].clientId, 'c-1');
  assert.equal(calls.createSession[0].staffProfileId, 'rbt-1');
});

test('an explicitly provided but INVALID plan is still rejected (PLAN_INVALID) — not silently dropped', async () => {
  const wrongClient = makeService({ plan: { id: 'p-1', clientId: 'someone-else', status: 'ACTIVE' } });
  await assert.rejects(
    () => wrongClient.service.createSession({ tenantId: 't', actorUserId: 'u', input: { appointmentId: 'ap-1', treatmentPlanId: 'p-1' } }),
    (e) => e.code === 'PLAN_INVALID' && e.status === 422,
  );
  const notActive = makeService({ plan: { id: 'p-1', clientId: 'c-1', status: 'DRAFT' } });
  await assert.rejects(
    () => notActive.service.createSession({ tenantId: 't', actorUserId: 'u', input: { appointmentId: 'ap-1', treatmentPlanId: 'p-1' } }),
    (e) => e.code === 'PLAN_INVALID',
  );
});
