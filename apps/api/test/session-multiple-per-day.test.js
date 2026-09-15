import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BcbaSessionService } from '../src/modules/bcba-session/bcbaSession.service.js';

/**
 * Phase 2 §3/§4/§5 — a clinician may record MULTIPLE independent sessions for
 * the same appointment on the same calendar day (each its own record/timing),
 * and a NEW session may only be STARTED on a day the appointment covers (org
 * timezone). Verified through the REAL BcbaSessionService against a faithful
 * "active-slot" sessions fake: findByAppointment returns only the OPEN session,
 * completing sets active:false (freeing the slot), and start creates a fresh one.
 */
const sealed = (v) => (v == null ? v : `s(${v})`);
const opened = (v) => (typeof v === 'string' && v.startsWith('s(') ? v.slice(2, -1) : v);

function makeService({ now = new Date('2026-09-09T15:00:00Z'), timezone = 'UTC', apptStart = new Date('2026-09-09T00:00:00Z'), apptEnd = new Date('2026-09-09T23:59:59Z') } = {}) {
  const appt = {
    id: 'appt-1', clientId: 'child-A', bcbaId: 'bcba-1', rbtId: null,
    authorizationId: 'auth-1', authorizationIds: ['auth-1'],
    startAt: apptStart, endAt: apptEnd, timeSet: true, units: 4, status: 'SCHEDULED',
  };
  const store = { sessions: [], seq: 0, timeRecords: [], now };
  const openFor = (apptId, staff) => store.sessions.find((s) => s.appointmentId === apptId && s.staffProfileId === staff && s.active && !s.deletedAt);

  const service = new BcbaSessionService({
    clock: { now: () => store.now },
    organizations: { getById: async () => ({ state: 'ACTIVE', timezone }) },
    settings: { getStaffing: async () => ({}) }, // no weekly target
    appointments: {
      findById: async (_t, id) => (id === appt.id ? { ...appt } : null),
      listForBcba: async () => [{ ...appt }],
      listForRbt: async () => [{ ...appt }],
    },
    sessions: {
      findByAppointment: async (_t, apptId, staff) => { const s = openFor(apptId, staff); return s ? { ...s } : null; },
      findById: async (_t, id) => { const s = store.sessions.find((x) => x.id === id); return s ? { ...s } : null; },
      create: async (_t, doc) => { const s = { id: `sess-${++store.seq}`, active: true, status: 'DRAFT', ...doc }; store.sessions.push(s); return { ...s }; },
      createSession: async (_t, doc) => { const s = { id: `sess-${++store.seq}`, active: true, status: 'DRAFT', ...doc }; store.sessions.push(s); return { ...s }; },
      update: async (_t, id, patch) => { const s = store.sessions.find((x) => x.id === id); Object.assign(s, patch); if (patch['sensitive.narrative'] !== undefined) s.sensitive = { narrative: patch['sensitive.narrative'] }; return { ...s }; },
      freeze: async (_t, id) => { const s = store.sessions.find((x) => x.id === id); s.status = 'FROZEN'; s.active = false; return { ...s }; },
    },
    plans: { findActivePlanForClient: async () => null },
    clients: { findById: async (_t, id) => ({ id, firstName: 'A', lastName: 'B' }) },
    authorizations: { resolveMany: async (_t, ids) => ids.map((id) => ({ id, label: id })) },
    payRates: { getCurrentHourlyRate: async () => 3000 },
    timeRecords: {
      findBySession: async (_t, sid) => store.timeRecords.find((r) => r.sessionId === sid) ?? null,
      create: async (_t, doc) => { const r = { id: `tr-${store.timeRecords.length + 1}`, ...doc }; store.timeRecords.push(r); return { ...r }; },
      list: async () => store.timeRecords.map((r) => ({ ...r })),
    },
    phi: { seal: sealed, open: opened },
  });
  return { service, store };
}

const ctx = { tenantId: 't', actorUserId: 'u', bcbaStaffProfileId: 'bcba-1' };

test('start → complete → start again produces TWO independent sessions the same day (§4/§5)', async () => {
  const { service, store } = makeService();
  const s1 = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  store.now = new Date(store.now.getTime() + 30 * 60000);
  await service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-1', memo: 'first' });
  const s2 = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  assert.notEqual(s1.id, s2.id, 'a brand-new session, not the completed one');
  assert.equal(store.sessions.length, 2);
  // First is completed/inactive; second is open — the previous is not overwritten.
  const first = store.sessions.find((s) => s.id === s1.id);
  const second = store.sessions.find((s) => s.id === s2.id);
  assert.equal(first.status, 'FROZEN');
  assert.equal(first.active, false);
  assert.equal(second.active, true);
});

test('resuming an already-open session returns the SAME session (no duplicate)', async () => {
  const { service, store } = makeService();
  const a = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  const b = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(a.id, b.id);
  assert.equal(store.sessions.length, 1);
});

test('each session keeps its own time record — completing twice records two (no overwrite)', async () => {
  const { service, store } = makeService();
  await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  store.now = new Date(store.now.getTime() + 30 * 60000);
  await service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-1' });
  await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  store.now = new Date(store.now.getTime() + 30 * 60000);
  await service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-1' });
  assert.equal(store.timeRecords.length, 2, 'two independent time records');
  assert.notEqual(store.timeRecords[0].sessionId, store.timeRecords[1].sessionId);
});

test('a NEW session cannot be started the NEXT day for a single-day appointment (§3)', async () => {
  const { service } = makeService({ now: new Date('2026-09-10T15:00:00Z') }); // day after the 09/09 appt
  await assert.rejects(
    () => service.startSession({ ...ctx, appointmentId: 'appt-1' }),
    (e) => e.code === 'APPOINTMENT_NOT_TODAY',
  );
});

test('a month-long appointment is startable on every day in its range (§1)', async () => {
  const opts = { apptStart: new Date('2026-09-01T00:00:00Z'), apptEnd: new Date('2026-09-30T23:59:59Z') };
  for (const day of ['2026-09-01T15:00:00Z', '2026-09-15T15:00:00Z', '2026-09-30T15:00:00Z']) {
    const { service } = makeService({ ...opts, now: new Date(day) });
    const s = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
    assert.ok(s.id, `startable on ${day}`);
  }
  // …but not the day after the range ends.
  const { service } = makeService({ ...opts, now: new Date('2026-10-01T15:00:00Z') });
  await assert.rejects(() => service.startSession({ ...ctx, appointmentId: 'appt-1' }), (e) => e.code === 'APPOINTMENT_NOT_TODAY');
});

test('RBT records multiple independent sessions the same day through the same pipeline (§7)', async () => {
  const svc = makeService();
  const rbtCtx = { tenantId: 't', actorUserId: 'u', bcbaStaffProfileId: 'rbt-1', role: 'RBT' };
  const rbtAppt = { id: 'appt-1', clientId: 'child-A', bcbaId: null, rbtId: 'rbt-1', authorizationIds: ['auth-1'], startAt: new Date('2026-09-09T00:00:00Z'), endAt: new Date('2026-09-09T23:59:59Z'), status: 'SCHEDULED', units: 4 };
  svc.service.deps.appointments.findById = async () => ({ ...rbtAppt });
  svc.service.deps.appointments.listForRbt = async () => [{ ...rbtAppt }];
  const a = await svc.service.startSession({ ...rbtCtx, appointmentId: 'appt-1' });
  svc.store.now = new Date(svc.store.now.getTime() + 20 * 60000);
  await svc.service.completeSession({ ...rbtCtx, appointmentId: 'appt-1', authorizationId: 'auth-1' });
  const b = await svc.service.startSession({ ...rbtCtx, appointmentId: 'appt-1' });
  assert.notEqual(a.id, b.id);
  assert.equal(svc.store.sessions.filter((s) => s.staffProfileId === 'rbt-1').length, 2);
});

test('day validity honors the ORGANIZATION timezone, not UTC', async () => {
  // 2026-09-10T02:00:00Z is still 09/09 in America/New_York (10:00 PM EDT).
  const { service } = makeService({ timezone: 'America/New_York', now: new Date('2026-09-10T02:00:00Z') });
  const s = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  assert.ok(s.id, 'valid because it is still 09/09 in the org timezone');
});
