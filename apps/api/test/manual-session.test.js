import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BcbaSessionService, manualAppointmentId } from '../src/modules/bcba-session/bcbaSession.service.js';
import { manualSessionSchema } from '../src/modules/bcba-session/bcbaSession.schemas.js';
import { projectStaffActivity } from '../src/modules/activity/activity.projection.js';
import { aggregatePeriodPayroll } from '../src/modules/payroll/payroll.periods.js';
import { aggregateChildBilling } from '../src/modules/claims/billing.aggregate.js';
import { zonedWallTimeToUtc } from '../src/domain/businessDate.js';
import { Session } from '../src/models/index.js';

/**
 * ---------------------------------------------------------------------------
 * MANUAL SESSION — BCBA & RBT, through the EXISTING pipeline.
 *
 * The REAL BcbaSessionService over faithful in-memory ports (tenant-keyed
 * stores; the appointment insert enforces its _id uniqueness like MongoDB).
 * The persisted Session / SessionTimeRecord / Appointment are then fed to the
 * REAL payroll projection + aggregator and the REAL insurance billing
 * aggregator, and My Hours reads the same time records — proving one source of
 * truth end to end. No live MongoDB in this environment.
 * ---------------------------------------------------------------------------
 */

const TZ = 'America/New_York';
const T1 = 'tenant-1';
const T2 = 'tenant-2';
const BCBA = 'bcba-1';
const OTHER_BCBA = 'bcba-2';
const RBT = 'rbt-1';
const OTHER_RBT = 'rbt-2';
const CHILD = 'child-test';
const OTHER_CHILD = 'child-other';
const AUTH = 'svc:auth-aba';
const seal = (v) => (v == null ? v : `s(${v})`);
const open = (v) => (typeof v === 'string' && v.startsWith('s(') ? v.slice(2, -1) : v);
const wall = (date, hh, mm = 0) => { const [y, m, d] = date.split('-').map(Number); return zonedWallTimeToUtc(y, m, d, hh, mm, 0, TZ); };

function makeWorld({ now = wall('2026-09-13', 12) } = {}) {
  const db = { appts: new Map(), sessions: [], timeRecords: [] };
  let seq = 0;
  // tenant → clientId → assignments
  const assignments = {
    [T1]: {
      [CHILD]: [
        { staffProfileId: BCBA, role: 'BCBA', status: 'ACTIVE' },
        { staffProfileId: RBT, role: 'RBT', status: 'ACTIVE' },
        { staffProfileId: OTHER_RBT, role: 'RBT', status: 'ENDED' },
      ],
      [OTHER_CHILD]: [{ staffProfileId: OTHER_BCBA, role: 'BCBA', status: 'ACTIVE' }],
    },
    [T2]: { [CHILD]: [] },
  };
  // tenant → authorizationId → bookable authorization
  const authorizations = {
    [T1]: {
      [AUTH]: { id: AUTH, clientId: CHILD, status: 'ACTIVE', startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2026-09-30T00:00:00Z'), serviceCode: '97153', authorizedUnits: 400, usedUnits: 0 },
      'svc:auth-2': { id: 'svc:auth-2', clientId: CHILD, status: 'ACTIVE', startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2026-12-31T00:00:00Z'), serviceCode: '97155' },
      'svc:pending': { id: 'svc:pending', clientId: CHILD, status: 'PENDING', startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2026-09-30T00:00:00Z') },
      'svc:other-child': { id: 'svc:other-child', clientId: OTHER_CHILD, status: 'ACTIVE', startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2026-09-30T00:00:00Z') },
      'svc:ended': { id: 'svc:ended', clientId: CHILD, status: 'ACTIVE', startDate: new Date('2026-08-01T00:00:00Z'), endDate: new Date('2026-09-12T00:00:00Z') },
    },
    [T2]: {},
  };
  const service = new BcbaSessionService({
    clock: { now: () => now },
    organizations: { getById: async () => ({ state: 'ACTIVE', timezone: TZ }) },
    settings: { getStaffing: async () => ({}) },
    assignments: { listActiveForClient: async (t, clientId) => assignments[t]?.[clientId] ?? [] },
    authorizations: {
      findById: async (t, id) => authorizations[t]?.[id] ?? null,
      resolveMany: async (_t, ids) => ids.map((id) => ({ id, label: id })),
    },
    appointments: {
      createManual: async (t, doc) => {
        if (db.appts.has(`${t}|${doc._id}`)) { const e = new Error('dup'); e.code = 11000; throw e; }
        const a = { id: doc._id ?? `appt-${++seq}`, tenantId: t, ...doc };
        db.appts.set(`${t}|${a.id}`, a);
        return { ...a };
      },
      findById: async (t, id) => { const a = db.appts.get(`${t}|${id}`); return a ? { ...a } : null; },
      listForBcba: async (t, id) => [...db.appts.values()].filter((a) => a.tenantId === t && a.bcbaId === id),
      listForRbt: async (t, id) => [...db.appts.values()].filter((a) => a.tenantId === t && a.rbtId === id),
    },
    sessions: {
      create: async (t, doc) => {
        if (db.failNextSessionCreate) { db.failNextSessionCreate = false; throw new Error('transient write failure'); }
        // Mirrors sessionsRepository.createSession: the unique generationKey index
        // violation surfaces as SESSION_EXISTS, not a raw 11000.
        if (doc.generationKey && db.sessions.some((x) => x.tenantId === t && x.generationKey === doc.generationKey)) {
          throw Object.assign(new Error('A session already exists for this appointment.'), { code: 'SESSION_EXISTS' });
        }
        const s = { id: `sess-${++seq}`, tenantId: t, ...doc }; db.sessions.push(s); return { ...s };
      },
      findByGenerationKey: async (t, key) => { const s = db.sessions.find((x) => x.tenantId === t && x.generationKey === key); return s ? { ...s } : null; },
      findByAppointment: async (t, apptId, staff) => { const s = db.sessions.find((x) => x.tenantId === t && x.appointmentId === apptId && x.staffProfileId === staff && x.active !== false); return s ? { ...s } : null; },
      findById: async (t, id) => { const s = db.sessions.find((x) => x.tenantId === t && x.id === id); return s ? { ...s } : null; },
    },
    clients: { findById: async (_t, id) => ({ id, firstName: 'Test', lastName: 'Child' }) },
    plans: { findActivePlanForClient: async () => null },
    payRates: { getCurrentHourlyRate: async ({ staffProfileId }) => (staffProfileId === RBT ? 25 : 60) },
    timeRecords: {
      findBySession: async (t, sid) => db.timeRecords.find((r) => r.tenantId === t && r.sessionId === sid) ?? null,
      create: async (t, doc) => {
        // Mirrors the SessionTimeRecord unique index on (tenantId, sessionId).
        if (db.timeRecords.some((r) => r.tenantId === t && r.sessionId === doc.sessionId)) { const e = new Error('dup'); e.code = 11000; throw e; }
        const r = { id: `tr-${db.timeRecords.length + 1}`, tenantId: t, ...doc }; db.timeRecords.push(r); return { ...r };
      },
      list: async (t, { staffProfileId, from, to }) => db.timeRecords.filter((r) => r.tenantId === t && r.staffProfileId === staffProfileId && new Date(r.startedAt) >= new Date(from) && new Date(r.startedAt) <= new Date(to)),
      sumWorkedSeconds: async (t, { staffProfileId, from, to }) => {
        const rows = db.timeRecords.filter((r) => r.tenantId === t && r.staffProfileId === staffProfileId && new Date(r.startedAt) >= new Date(from) && new Date(r.startedAt) < new Date(to));
        return { seconds: rows.reduce((s, r) => s + (new Date(r.endedAt) - new Date(r.startedAt)) / 1000, 0), sessions: rows.length };
      },
    },
    phi: { seal, open },
  });
  return { service, db };
}

const bcbaCtx = { tenantId: T1, actorUserId: 'user-bcba', bcbaStaffProfileId: BCBA, role: 'BCBA' };
const rbtCtx = { tenantId: T1, actorUserId: 'user-rbt', bcbaStaffProfileId: RBT, role: 'RBT' };
const input = (over = {}) => ({ clientId: CHILD, date: '2026-09-13', startTime: '10:00', endTime: '11:30', authorizationIds: [AUTH], memo: 'Manual session', ...over });
const rejects = (p, code, message) => assert.rejects(p, (e) => {
  assert.equal(e.code, code);
  if (message) assert.equal(e.message, message);
  return true;
});

// ============================ FINAL ACCEPTANCE ==============================

test('ACCEPTANCE — BCBA 09/13/2026 10:00–11:30 AM → Session + 90-min time record → My Hours → Payroll → Billing; RBT independent', async () => {
  const { service, db } = makeWorld();
  const res = await service.createManualSession({ ...bcbaCtx, input: input() });
  assert.equal(res.alreadyExists, false);

  // Session (real, completed, manual, clinician from the token)
  const s = db.sessions[0];
  assert.equal(s.staffProfileId, BCBA);
  assert.equal(s.clientId, CHILD);
  assert.equal(s.status, 'FROZEN');
  assert.equal(s.active, false);
  assert.equal(s.source, 'MANUAL');
  assert.equal(s.startedAt.toISOString(), wall('2026-09-13', 10).toISOString());
  assert.equal(s.endedAt.toISOString(), wall('2026-09-13', 11, 30).toISOString());
  assert.equal(s.clockInAt.toISOString(), s.startedAt.toISOString());
  assert.equal(s.clockOutAt.toISOString(), s.endedAt.toISOString());
  assert.deepEqual(s.selectedAuthorizationIds, [AUTH]);
  assert.equal(open(s.sensitive.narrative), 'Manual session');
  assert.equal(res.session.narrative ?? res.session.memo, 'Manual session');

  // Appointment: real, COMPLETED, role-attributed, authorization attached
  const appt = [...db.appts.values()][0];
  assert.equal(appt.status, 'COMPLETED');
  assert.equal(appt.bcbaId, BCBA);
  assert.equal(appt.rbtId, null);
  assert.deepEqual(appt.authorizationIds, [AUTH]);
  assert.equal(appt.id, manualAppointmentId(T1, s.generationKey));

  // SessionTimeRecord = 90 minutes, server-computed
  assert.equal(db.timeRecords.length, 1);
  const tr = db.timeRecords[0];
  assert.equal(tr.workedMinutes, 90);
  assert.equal(tr.sessionId, s.id);
  assert.deepEqual(tr.authorizationIds, [AUTH]);

  // My Hours includes the 90 minutes
  const hours = await service.getMyHours({ tenantId: T1, bcbaStaffProfileId: BCBA, now: wall('2026-09-13', 18) });
  assert.equal(hours.totalSeconds, 90 * 60);
  assert.equal(hours.text, '1h 30m 0s');

  // RBT creates their OWN manual session for the same child/time independently.
  await service.createManualSession({ ...rbtCtx, input: input({ memo: 'RBT manual session' }) });
  assert.equal(db.sessions.length, 2);
  assert.equal(db.timeRecords.length, 2);
  assert.equal(db.sessions[0].status, 'FROZEN');
  assert.equal(db.sessions[0].staffProfileId, BCBA, 'BCBA session untouched');
  assert.equal(open(db.sessions[0].sensitive.narrative), 'Manual session');
  const rbtAppt = [...db.appts.values()].find((a) => a.rbtId === RBT);
  assert.equal(rbtAppt.bcbaId, null, 'RBT record carries no BCBA');
  assert.notEqual(rbtAppt.id, appt.id);

  // Payroll: existing projection + aggregator, effective staff rate × worked minutes, per clinician.
  const workedById = new Map(db.timeRecords.map((r) => [r.sessionId, r.workedMinutes]));
  const apptById = new Map([...db.appts.values()].map((a) => [a.id, a]));
  const rateByStaffId = new Map([[BCBA, { rateCents: 6000, rateType: 'HOURLY' }], [RBT, { rateCents: 2500, rateType: 'HOURLY' }]]);
  const activities = projectStaffActivity({ sessions: db.sessions, workedById, apptById, rateByStaffId });
  const payroll = aggregatePeriodPayroll({
    records: activities.map((a) => ({ sessionId: a.sessionId, staffProfileId: a.staffProfileId, appointmentId: a.appointmentId, clientId: a.clientId, startedAt: a.sessionStart, endedAt: a.sessionEnd, workedMinutes: a.workedMinutes, hourlyRateSnapshot: null })),
    apptById,
    rateByStaff: new Map([[BCBA, 6000], [RBT, 2500]]),
    window: { start: wall('2026-09-07', 0), end: wall('2026-09-21', 0) },
  });
  const bcbaRow = payroll.staff.find((r) => r.staffProfileId === BCBA);
  const rbtRow = payroll.staff.find((r) => r.staffProfileId === RBT);
  assert.deepEqual([bcbaRow.role, bcbaRow.workedMinutes, bcbaRow.amount], ['BCBA', 90, 9000]);  // 1.5h × $60.00
  assert.deepEqual([rbtRow.role, rbtRow.workedMinutes, rbtRow.amount], ['RBT', 90, 3750]);     // 1.5h × $25.00

  // Insurance billing: the completed session is billing-ready automatically and
  // bills its actual worked minutes at the clinician's Staff Profile hourly rate.
  const billing = aggregateChildBilling({
    sessions: db.sessions.filter((x) => x.staffProfileId === BCBA),
    workedById, apptById,
    payRatesByStaffId: new Map([[BCBA, [{ rateType: 'HOURLY', amount: 6000, effectiveFrom: new Date('2026-01-01') }]]]),
    authById: new Map([[AUTH, { id: AUTH, authorizationNumber: 'AUTH-1', billingCode: '97153' }]]),
    window: { start: wall('2026-09-07', 0), end: wall('2026-09-21', 0) },
  });
  assert.equal(billing.sessions.length, 1);
  assert.equal(billing.sessions[0].billingStatus, 'READY');
  assert.equal(billing.sessions[0].workedMinutes, 90);
  assert.equal(billing.sessions[0].hourlyRate, 6000);
  assert.equal(billing.sessions[0].amount, 9000, '1.5h × $60.00/hr');
});

// ============================ CLINICIAN OWNERSHIP ===========================

test('RBT can create a manual session (RBT-owned appointment, session and time record)', async () => {
  const { service, db } = makeWorld();
  const r = await service.createManualSession({ ...rbtCtx, input: input({ startTime: '14:00', endTime: '15:30' }) });
  assert.equal(r.timeRecord.workedMinutes, 90);
  assert.equal(db.sessions[0].staffProfileId, RBT);
  const appt = [...db.appts.values()][0];
  assert.deepEqual([appt.rbtId, appt.bcbaId], [RBT, null]);
  const hours = await service.getMyHours({ tenantId: T1, bcbaStaffProfileId: RBT, now: wall('2026-09-13', 18) });
  assert.equal(hours.text, '1h 30m 0s');
});

test('the request body cannot name another clinician, tenant, role or duration (schema is strict)', () => {
  for (const extra of [{ staffProfileId: OTHER_BCBA }, { tenantId: T2 }, { role: 'BCBA' }, { workedMinutes: 600 }, { bcbaId: OTHER_BCBA }]) {
    assert.equal(manualSessionSchema.safeParse({ ...input(), ...extra }).success, false, JSON.stringify(extra));
  }
  assert.equal(manualSessionSchema.safeParse(input()).success, true);
});

test('BCBA cannot record for a client they are not assigned to (e.g. another BCBA\'s client)', async () => {
  const { service, db } = makeWorld();
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ clientId: OTHER_CHILD, authorizationIds: ['svc:other-child'] }) }), 'NOT_ASSIGNED_TO_CHILD');
  assert.equal(db.sessions.length + db.timeRecords.length + db.appts.size, 0);
});

test('RBT cannot record for another RBT: an RBT whose assignment ended is refused; the RBT route never grants BCBA role', async () => {
  const { service } = makeWorld();
  await rejects(service.createManualSession({ tenantId: T1, actorUserId: 'u', bcbaStaffProfileId: OTHER_RBT, role: 'RBT', input: input() }), 'NOT_ASSIGNED_TO_CHILD');
  // An RBT calling the BCBA endpoint (role BCBA) is not a BCBA on the care team.
  await rejects(service.createManualSession({ ...rbtCtx, role: 'BCBA', input: input() }), 'NOT_ASSIGNED_TO_CHILD');
  // …and a BCBA calling the RBT endpoint likewise.
  await rejects(service.createManualSession({ ...bcbaCtx, role: 'RBT', input: input() }), 'NOT_ASSIGNED_TO_CHILD');
});

test('client tenant isolation: the same client id in another tenant is not accessible', async () => {
  const { service, db } = makeWorld();
  await rejects(service.createManualSession({ ...bcbaCtx, tenantId: T2, input: input() }), 'NOT_ASSIGNED_TO_CHILD');
  assert.equal(db.sessions.length, 0);
});

// ============================ AUTHORIZATION =================================

test('authorization is required, tenant-scoped, client-bound, usable and valid for the date', async () => {
  const { service, db } = makeWorld();
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: [] }) }), 'AUTHORIZATION_REQUIRED', 'Select an authorization for this client.');
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: undefined }) }), 'AUTHORIZATION_REQUIRED');
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: ['svc:other-child'] }) }), 'AUTHORIZATION_NOT_FOR_CLIENT', 'Select an authorization for this client.');
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: ['svc:does-not-exist'] }) }), 'AUTHORIZATION_NOT_FOR_CLIENT');
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: ['svc:pending'] }) }), 'AUTHORIZATION_NOT_USABLE');
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: ['svc:ended'] }) }), 'AUTHORIZATION_NOT_VALID_FOR_DATE');
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: [AUTH, 'svc:pending'] }) }), 'AUTHORIZATION_NOT_USABLE');
  assert.equal(db.sessions.length + db.timeRecords.length + db.appts.size, 0, 'no partial records');
});

test('authorization from another tenant is rejected even with a valid-looking id', async () => {
  const { service } = makeWorld();
  // Give tenant 2 a care-team assignment so only the authorization check can refuse.
  const t2 = { ...bcbaCtx, tenantId: T2 };
  service.deps.assignments.listActiveForClient = async () => [{ staffProfileId: BCBA, role: 'BCBA', status: 'ACTIVE' }];
  await rejects(service.createManualSession({ ...t2, input: input() }), 'AUTHORIZATION_NOT_FOR_CLIENT');
});

test('the authorization end date is inclusive: a session on the last authorized day is accepted', async () => {
  const { service } = makeWorld();
  const r = await service.createManualSession({ ...bcbaCtx, input: input({ date: '2026-09-12', authorizationIds: ['svc:ended'], startTime: '20:00', endTime: '21:00' }) });
  assert.equal(r.timeRecord.workedMinutes, 60);
});

test('multiple selected authorizations are persisted in order', async () => {
  const { service, db } = makeWorld();
  await service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: [AUTH, 'svc:auth-2', AUTH] }) });
  assert.deepEqual(db.sessions[0].selectedAuthorizationIds, [AUTH, 'svc:auth-2']);
  assert.equal(db.sessions[0].selectedAuthorizationId, AUTH);
});

// ============================ TIME RULES ====================================

test('15-minute increments accepted: :00 :15 :30 :45', async () => {
  const { service, db } = makeWorld();
  const cases = [['08:00', '08:15'], ['08:30', '08:45'], ['09:15', '10:00']];
  for (const [startTime, endTime] of cases) await service.createManualSession({ ...bcbaCtx, input: input({ startTime, endTime }) });
  assert.deepEqual(db.timeRecords.map((r) => r.workedMinutes), [15, 15, 45]);
});

test('non-15-minute increments rejected with the specific message (and nothing written)', async () => {
  const { service, db } = makeWorld();
  for (const [startTime, endTime] of [['09:10', '10:00'], ['09:00', '09:20'], ['09:37', '10:00']]) {
    await rejects(service.createManualSession({ ...bcbaCtx, input: input({ startTime, endTime }) }), 'INVALID_TIME_INCREMENT', 'Session times must be in 15-minute increments.');
  }
  assert.equal(db.sessions.length, 0);
});

test('end before / equal to start rejected; invalid calendar date rejected', async () => {
  const { service, db } = makeWorld();
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ startTime: '11:30', endTime: '10:00' }) }), 'INVALID_TIME', 'End time must be after start time.');
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ startTime: '10:00', endTime: '10:00' }) }), 'INVALID_TIME');
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ date: '2026-02-30' }) }), 'INVALID_DATE');
  assert.equal(db.sessions.length, 0);
});

test('worked minutes are computed server-side from the org wall clock — DST-correct', async () => {
  const { service, db } = makeWorld({ now: wall('2026-11-01', 20) });
  service.deps.authorizations.findById = async () => ({ clientId: CHILD, status: 'ACTIVE', startDate: null, endDate: null });
  // US fall-back day: 11:00 AM → 1:00 PM is 120 real minutes, anchored at the org wall clock.
  await service.createManualSession({ ...bcbaCtx, input: input({ date: '2026-11-01', startTime: '11:00', endTime: '13:00' }) });
  assert.equal(db.timeRecords[0].workedMinutes, 120);
  assert.equal(db.sessions[0].startedAt.toISOString(), '2026-11-01T16:00:00.000Z'); // 11:00 EST
});

// ============================ DUPLICATES / CONFLICTS ========================

test('an identical repeat returns the existing session — never a second session or time record', async () => {
  const { service, db } = makeWorld();
  const a = await service.createManualSession({ ...bcbaCtx, input: input() });
  const b = await service.createManualSession({ ...bcbaCtx, input: input() });
  assert.equal(b.alreadyExists, true);
  assert.equal(b.session.id, a.session.id);
  assert.equal(db.sessions.length, 1);
  assert.equal(db.timeRecords.length, 1);
  assert.equal(db.appts.size, 1);
});

test('two concurrent identical requests: the deterministic appointment id stops the second write', async () => {
  const { service, db } = makeWorld();
  const [a, b] = await Promise.allSettled([
    service.createManualSession({ ...bcbaCtx, input: input() }),
    service.createManualSession({ ...bcbaCtx, input: input() }),
  ]);
  const fulfilled = [a, b].filter((x) => x.status === 'fulfilled');
  assert.ok(fulfilled.length >= 1);
  for (const r of [a, b]) if (r.status === 'rejected') assert.equal(r.reason.code, 'SESSION_CONFLICT');
  assert.equal(db.sessions.length, 1);
  assert.equal(db.timeRecords.length, 1);
  assert.equal(db.appts.size, 1);
});

test('overlapping work for the SAME clinician is a conflict; the other clinician is unaffected', async () => {
  const { service, db } = makeWorld();
  await service.createManualSession({ ...bcbaCtx, input: input() });                                        // 10:00–11:30
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ startTime: '11:00', endTime: '12:00' }) }), 'SESSION_CONFLICT', 'You already have a session recorded during this time.');
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ startTime: '09:00', endTime: '10:15' }) }), 'SESSION_CONFLICT');
  // Adjacent is fine.
  await service.createManualSession({ ...bcbaCtx, input: input({ startTime: '11:30', endTime: '12:00' }) });
  // The RBT can record the same window for themselves.
  await service.createManualSession({ ...rbtCtx, input: input() });
  assert.equal(db.sessions.length, 3);
});

// ============================ PANEL / SCHEDULING ============================

test('the manual appointment is COMPLETED: never offered for Start Session and refused if started', async () => {
  const { service } = makeWorld({ now: wall('2026-09-13', 12) });
  await service.createManualSession({ ...bcbaCtx, input: input() });
  const [card] = await service.listPanel({ tenantId: T1, bcbaStaffProfileId: BCBA });
  assert.equal(card.sessionStatus, 'COMPLETED');
  assert.equal(card.canStart, false);
  await rejects(service.startSession({ ...bcbaCtx, appointmentId: card.appointmentId }), 'APPOINTMENT_NOT_STARTABLE');
});

test('the RBT panel shows only the RBT\'s own manual session — no BCBA data', async () => {
  const { service } = makeWorld();
  await service.createManualSession({ ...bcbaCtx, input: input() });
  await service.createManualSession({ ...rbtCtx, input: input({ startTime: '13:00', endTime: '14:00' }) });
  const rbtCards = await service.listPanel({ tenantId: T1, bcbaStaffProfileId: RBT, role: 'RBT' });
  assert.equal(rbtCards.length, 1);
  assert.equal(rbtCards[0].bcbaId, null);
  assert.equal(rbtCards[0].rbtId, RBT);
});

test('database: the Session model carries source + a unique partial index on the manual key', () => {
  assert.deepEqual(Session.schema.path('source').enumValues, ['MANUAL', null]);
  assert.equal(Session.schema.path('source').defaultValue, null);
  const idx = Session.schema.indexes().find(([k]) => k.generationKey === 1);
  assert.ok(idx, 'generationKey index exists');
  assert.equal(idx[1].unique, true);
  assert.deepEqual(idx[1].partialFilterExpression.generationKey, { $type: 'string' });
});

// ======================= DUPLICATE / RACE HARDENING =========================

test('duplicate identity includes the authorization set: same time + different authorization is a conflict, not a silent repeat', async () => {
  const { service, db } = makeWorld();
  const first = await service.createManualSession({ ...bcbaCtx, input: input() });
  assert.ok(db.sessions[0].generationKey.endsWith(`:${AUTH}`), 'the authorization is part of the duplicate identity');
  // A repeated id in the selection does not change the identity.
  const again = await service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: [AUTH, AUTH] }) });
  assert.equal(again.alreadyExists, true);
  assert.equal(again.session.id, first.session.id);
  // Same clinician + same time under a DIFFERENT authorization is not a repeat:
  // it would double the clinician's hours, so it is refused as a conflict.
  await rejects(service.createManualSession({ ...bcbaCtx, input: input({ authorizationIds: ['svc:auth-2'] }) }), 'SESSION_CONFLICT');
  // Selection order is irrelevant for a multi-authorization entry.
  const multi = await service.createManualSession({ ...bcbaCtx, input: input({ startTime: '13:00', endTime: '14:00', authorizationIds: ['svc:auth-2', AUTH] }) });
  const multiAgain = await service.createManualSession({ ...bcbaCtx, input: input({ startTime: '13:00', endTime: '14:00', authorizationIds: [AUTH, 'svc:auth-2'] }) });
  assert.equal(multiAgain.alreadyExists, true);
  assert.equal(multiAgain.session.id, multi.session.id);
  assert.equal(db.sessions.length, 2);
});

test('a session write that loses the race (repository SESSION_EXISTS) returns the winner instead of failing', async () => {
  const { service, db } = makeWorld();
  const winner = await service.createManualSession({ ...bcbaCtx, input: input() });
  // Simulate the loser: its idempotency read ran before the winner's session existed.
  const realFind = service.deps.sessions.findByGenerationKey;
  let calls = 0;
  service.deps.sessions.findByGenerationKey = async (...a) => (calls++ === 0 ? null : realFind(...a));
  service.deps.timeRecords.list = async () => []; // …and before the winner's time record
  const loser = await service.createManualSession({ ...bcbaCtx, input: input() });
  assert.equal(loser.alreadyExists, true);
  assert.equal(loser.session.id, winner.session.id);
  assert.equal(db.sessions.length, 1);
  assert.equal(db.timeRecords.length, 1);
});

test('a retry after a partial failure (appointment written, session not) completes the SAME entry', async () => {
  const { service, db } = makeWorld();
  db.failNextSessionCreate = true;
  await assert.rejects(service.createManualSession({ ...bcbaCtx, input: input() }), /transient write failure/);
  assert.equal(db.appts.size, 1);
  assert.equal(db.sessions.length, 0);
  const retry = await service.createManualSession({ ...bcbaCtx, input: input() });
  assert.equal(retry.alreadyExists, false);
  assert.equal(db.appts.size, 1, 'no second appointment');
  assert.equal(db.sessions.length, 1);
  assert.equal(db.timeRecords.length, 1);
  assert.equal(retry.timeRecord.workedMinutes, 90);
  assert.equal(db.sessions[0].appointmentId, [...db.appts.values()][0].id);
});
