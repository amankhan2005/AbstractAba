import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BcbaSessionService } from '../src/modules/bcba-session/bcbaSession.service.js';

/**
 * DB-free tests for the RBT technician panel, which reuses the SAME
 * BcbaSessionService with role: 'RBT'. They lock in the RBT-specific rules:
 *   - the panel lists the RBT's OWN assignments (listForRbt, by rbtId);
 *   - ownership is proven against appointment.rbtId (not bcbaId);
 *   - a wrong RBT / an appointment not assigned to this RBT is rejected;
 *   - the BCBA weekly-target gate is NOT applied to the RBT start path;
 *   - complete freezes + writes the one SessionTimeRecord (My Hours source);
 *   - My Hours sums only this staff's records and carries no pay fields.
 */

const FIXED_NOW = new Date('2026-09-05T11:46:37.000Z');
const START = new Date('2026-09-05T10:31:14.000Z');

function makeService({
  state = 'ACTIVE', appointment = {}, session = null, activePlan = { id: 'plan-A' },
  now = FIXED_NOW, staffing = null, weeklyRecords = [],
} = {}) {
  const appt = {
    id: 'appt-1', clientId: 'child-A', bcbaId: 'bcba-1', rbtId: 'rbt-1',
    authorizationId: 'auth-ABA', authorizationIds: ['auth-ABA', 'auth-FBA'],
    startAt: START, endAt: FIXED_NOW, units: 4, status: 'SCHEDULED', ...appointment,
  };
  const store = { session: session ? { ...session } : null, timeRecords: [], createdSessions: [], updates: [], freezes: [], createdRecords: [] };
  const sealed = (v) => (v == null ? v : `sealed(${v})`);
  const opened = (v) => (typeof v === 'string' && v.startsWith('sealed(') ? v.slice(7, -1) : v);

  const service = new BcbaSessionService({
    clock: { now: () => now },
    organizations: { getById: async () => ({ state, timezone: 'UTC' }) },
    appointments: {
      findById: async (_t, id) => (id === appt.id ? { ...appt } : null),
      listForBcba: async () => [], // a BCBA panel would use this; RBT must not
      listForRbt: async (_t, rbtId) => (rbtId === appt.rbtId ? [{ ...appt }] : []),
    },
    sessions: {
      findByAppointment: async () => (store.session ? { ...store.session } : null),
      findById: async () => (store.session ? { ...store.session } : null),
      create: async (_t, doc) => { store.createdSessions.push(doc); store.session = { id: 'sess-1', version: 1, ...doc }; return { ...store.session }; },
      update: async (_t, id, patch) => {
        store.updates.push({ id, patch });
        store.session = { ...store.session, ...patch };
        if (patch['sensitive.narrative'] !== undefined) store.session.sensitive = { narrative: patch['sensitive.narrative'] };
        return { ...store.session };
      },
      freeze: async (_t, id, actor) => { store.freezes.push({ id, actor }); store.session = { ...store.session, status: 'FROZEN', frozenAt: now, frozenBy: actor }; return { ...store.session }; },
    },
    plans: { findActivePlanForClient: async () => (activePlan ? { ...activePlan } : null), summarize: async () => ({ goalCount: 2, programCount: 1 }) },
    clients: { findById: async (_t, id) => ({ id, firstName: 'Ada', lastName: 'Byron', dateOfBirth: '2016-05-01', status: 'ACTIVE' }) },
    authorizations: { resolveMany: async (_t, ids) => ids.map((id) => ({ id, label: id === 'auth-ABA' ? 'ABA — AUTH-1' : 'FBA — AUTH-2', serviceCode: id === 'auth-ABA' ? 'ABA' : 'FBA' })) },
    payRates: { getCurrentHourlyRate: async () => 30 },
    settings: staffing ? { getStaffing: async () => staffing } : undefined,
    timeRecords: {
      findBySession: async (_t, sid) => store.timeRecords.find((r) => r.sessionId === sid) ?? null,
      create: async (_t, doc) => { const dup = store.timeRecords.find((r) => r.sessionId === doc.sessionId); if (dup) return { ...dup }; const rec = { id: `tr-${store.timeRecords.length + 1}`, ...doc }; store.timeRecords.push(rec); store.createdRecords.push(rec); return { ...rec }; },
      list: async () => store.timeRecords.map((r) => ({ ...r })),
      sumWorkedMinutes: async () => ({ minutes: weeklyRecords.reduce((a, r) => a + (r.workedMinutes || 0), 0), sessions: weeklyRecords.length }),
      sumWorkedSeconds: async () => ({ seconds: weeklyRecords.reduce((a, r) => a + (r.workedSeconds || 0), 0), sessions: weeklyRecords.length }),
    },
    phi: { seal: sealed, open: opened },
  });
  return { service, store, appt };
}

const rbt = { tenantId: 't1', actorUserId: 'u-rbt', bcbaStaffProfileId: 'rbt-1', role: 'RBT' };

test('RBT panel lists the RBT\u2019s own assignments (by rbtId), not the BCBA list', async () => {
  const { service } = makeService();
  const cards = await service.listPanel({ tenantId: 't1', bcbaStaffProfileId: 'rbt-1', role: 'RBT' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].appointmentId, 'appt-1');
  assert.equal(cards[0].rbtId, 'rbt-1');
  assert.equal(cards[0].canStart, true);
});

test('RBT start: assigned RBT + valid appointment → IN_PROGRESS, deliverer = rbt, server startedAt', async () => {
  const { service, store } = makeService();
  const s = await service.startSession({ ...rbt, appointmentId: 'appt-1' });
  assert.equal(s.status, 'IN_PROGRESS');
  assert.equal(store.createdSessions.length, 1);
  assert.equal(store.createdSessions[0].staffProfileId, 'rbt-1'); // RBT is the deliverer
  assert.equal(new Date(s.startedAt).toISOString(), FIXED_NOW.toISOString());
});

test('RBT start: a different RBT is rejected (NOT_YOUR_APPOINTMENT)', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.startSession({ ...rbt, bcbaStaffProfileId: 'rbt-OTHER', appointmentId: 'appt-1' }),
    (e) => e.code === 'NOT_YOUR_APPOINTMENT',
  );
});

test('RBT start: an appointment with no rbt assignment is rejected', async () => {
  const { service } = makeService({ appointment: { rbtId: null } });
  await assert.rejects(
    () => service.startSession({ ...rbt, appointmentId: 'appt-1' }),
    (e) => e.code === 'NOT_YOUR_APPOINTMENT',
  );
});

test('RBT start does NOT apply the BCBA weekly-target gate even when a target is configured and met', async () => {
  // A configured 1-hour target already met by 120 recorded minutes would BLOCK a
  // BCBA new-session start; the RBT path must ignore it entirely.
  const { service, store } = makeService({
    staffing: { weeklyHoursTarget: 1, weekStartsOn: 0 },
    weeklyRecords: [{ workedMinutes: 120 }],
  });
  const s = await service.startSession({ ...rbt, appointmentId: 'appt-1' });
  assert.equal(s.status, 'IN_PROGRESS');
  assert.equal(store.createdSessions.length, 1);
});

test('RBT complete: freezes the session and writes exactly one SessionTimeRecord', async () => {
  const { service, store } = makeService({
    session: { id: 'sess-1', clientId: 'child-A', staffProfileId: 'rbt-1', status: 'IN_PROGRESS', startedAt: START, endedAt: null, version: 2 },
  });
  const r = await service.completeSession({ ...rbt, appointmentId: 'appt-1', authorizationId: 'auth-ABA', memo: 'Worked on manding' });
  assert.equal(store.freezes.length, 1);
  assert.equal(store.createdRecords.length, 1);
  assert.equal(store.createdRecords[0].staffProfileId, 'rbt-1');
  assert.equal(store.createdRecords[0].authorizationId, 'auth-ABA');
  assert.equal(r.alreadyCompleted, false);
});

test('RBT complete: an authorization not on the appointment is rejected', async () => {
  const { service } = makeService({
    session: { id: 'sess-1', clientId: 'child-A', staffProfileId: 'rbt-1', status: 'IN_PROGRESS', startedAt: START, endedAt: null, version: 2 },
  });
  await assert.rejects(
    () => service.completeSession({ ...rbt, appointmentId: 'appt-1', authorizationId: 'auth-SOMEONE-ELSE' }),
    (e) => e.code === 'INVALID_AUTHORIZATION',
  );
});

test('RBT My Hours: worked time only (h/m/s), no pay fields, scoped to this staff', async () => {
  const { service } = makeService({ weeklyRecords: [{ workedSeconds: 3723 }] }); // 1h 02m 03s
  const out = await service.getMyHours({ tenantId: 't1', bcbaStaffProfileId: 'rbt-1', period: 'week' });
  assert.equal(out.totalSeconds, 3723);
  assert.equal(out.hours, 1);
  assert.equal(out.minutes, 2);
  assert.equal(out.seconds, 3);
  // Never any pay fields.
  assert.equal(out.amount, undefined);
  assert.equal(out.hourlyRateSnapshot, undefined);
  assert.equal(out.currency, undefined);
});
