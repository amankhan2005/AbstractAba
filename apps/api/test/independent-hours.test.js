import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BcbaSessionService } from '../src/modules/bcba-session/bcbaSession.service.js';

/**
 * Spec §9A — the SAME appointment assigned to a BCBA and an RBT produces TWO
 * INDEPENDENT sessions with independent timing, worked minutes, SessionTimeRecords
 * and payroll inputs. Exercised through the REAL BcbaSessionService with fake
 * ports that faithfully model the persistence contract that matters here:
 *   - a session is keyed by (appointmentId, staffProfileId) — the fix for the
 *     one-session-per-appointment collision; and
 *   - one SessionTimeRecord per session.
 * A fake that keyed sessions by appointmentId alone (the OLD behaviour) would
 * hand the RBT the BCBA's session and FAIL these assertions — which is exactly
 * the regression this test guards.
 */

const APPT = 'appt-1';
const T = (iso) => new Date(iso);

function makeWorld() {
  let clockNow = T('2026-09-05T10:00:00.000Z');
  const sessions = new Map();        // `${appt}::${staff}` → session
  const byId = new Map();            // sessionId → key
  const timeRecords = [];            // one per sessionId
  let sSeq = 0; let tSeq = 0;

  const appt = {
    id: APPT, clientId: 'child-A', bcbaId: 'bcba-1', rbtId: 'rbt-1',
    authorizationId: 'auth-ABA', authorizationIds: ['auth-ABA'],
    startAt: T('2026-09-05T10:00:00.000Z'), endAt: T('2026-09-05T13:00:00.000Z'),
    units: 4, status: 'SCHEDULED',
  };
  // Different hourly rates prove payroll uses each clinician's OWN rate × minutes.
  const RATE = { 'bcba-1': 50, 'rbt-1': 25 };

  const service = new BcbaSessionService({
    clock: { now: () => clockNow },
    organizations: { getById: async () => ({ state: 'ACTIVE' }) },
    appointments: {
      findById: async (_t, id) => (id === APPT ? { ...appt } : null),
      listForBcba: async () => [{ ...appt }],
      listForRbt: async () => [{ ...appt }],
    },
    sessions: {
      findByAppointment: async (_t, apptId, staffProfileId) => {
        const s = sessions.get(`${apptId}::${staffProfileId}`);
        return s ? { ...s } : null;
      },
      findById: async (_t, id) => { const k = byId.get(id); return k ? { ...sessions.get(k) } : null; },
      create: async (_t, doc) => {
        sSeq += 1;
        const key = `${doc.appointmentId}::${doc.staffProfileId}`;
        if (sessions.has(key)) throw new Error('unique (appointment, staff) violated'); // model index
        const s = { id: `sess-${sSeq}`, version: 1, ...doc };
        sessions.set(key, s); byId.set(s.id, key);
        return { ...s };
      },
      update: async (_t, id, patch) => {
        const key = byId.get(id); const s = { ...sessions.get(key), ...patch };
        if (patch['sensitive.narrative'] !== undefined) s.sensitive = { narrative: patch['sensitive.narrative'] };
        sessions.set(key, s); return { ...s };
      },
      freeze: async (_t, id, actor) => {
        const key = byId.get(id); const s = { ...sessions.get(key), status: 'FROZEN', frozenAt: clockNow, frozenBy: actor };
        sessions.set(key, s); return { ...s };
      },
    },
    plans: { findActivePlanForClient: async () => ({ id: 'plan-A' }), summarize: async () => ({}) },
    clients: { findById: async (_t, id) => ({ id, firstName: 'Ada', lastName: 'Byron', status: 'ACTIVE' }) },
    authorizations: { resolveMany: async (_t, ids) => ids.map((id) => ({ id, label: 'ABA', serviceCode: 'ABA', status: 'ACTIVE' })) },
    payRates: { getCurrentHourlyRate: async ({ staffProfileId }) => RATE[staffProfileId] ?? 0 },
    timeRecords: {
      findBySession: async (_t, sid) => timeRecords.find((r) => r.sessionId === sid) ?? null,
      create: async (_t, doc) => {
        if (timeRecords.find((r) => r.sessionId === doc.sessionId)) return { ...timeRecords.find((r) => r.sessionId === doc.sessionId) };
        tSeq += 1; const rec = { id: `tr-${tSeq}`, ...doc }; timeRecords.push(rec); return { ...rec };
      },
      list: async () => timeRecords.map((r) => ({ ...r })),
    },
    phi: { seal: (v) => v, open: (v) => v },
  });

  return {
    service, timeRecords,
    setClock: (iso) => { clockNow = T(iso); },
    session: (staff) => sessions.get(`${APPT}::${staff}`),
  };
}

test('§9A — same appointment, BCBA + RBT: two independent sessions, worked minutes, records, payroll', async () => {
  const w = makeWorld();
  const bcba = { tenantId: 't1', actorUserId: 'u-bcba', bcbaStaffProfileId: 'bcba-1', appointmentId: APPT, role: 'BCBA' };
  const rbt = { tenantId: 't1', actorUserId: 'u-rbt', bcbaStaffProfileId: 'rbt-1', appointmentId: APPT, role: 'RBT' };

  // BCBA starts 10:00; RBT starts 10:15 — same appointment, two sessions.
  w.setClock('2026-09-05T10:00:00.000Z');
  const bStart = await w.service.startSession(bcba);
  w.setClock('2026-09-05T10:15:00.000Z');
  const rStart = await w.service.startSession(rbt);

  assert.notEqual(bStart.id, rStart.id, 'BCBA and RBT must get DIFFERENT session ids');
  assert.equal(w.session('bcba-1').staffProfileId, 'bcba-1');
  assert.equal(w.session('rbt-1').staffProfileId, 'rbt-1');

  // BCBA completes at 11:30 (90 min). RBT still running and untouched.
  w.setClock('2026-09-05T11:30:00.000Z');
  const bDone = await w.service.completeSession({ ...bcba, authorizationId: 'auth-ABA', memo: 'bcba note' });
  assert.equal(bDone.timeRecord.workedMinutes, 90, 'BCBA worked 90 minutes');
  assert.equal(w.session('rbt-1').status, 'IN_PROGRESS', 'completing BCBA must NOT complete RBT');
  assert.equal(w.session('rbt-1').endedAt ?? null, null, 'RBT clock-out untouched by BCBA completion');

  // RBT completes at 12:45 (150 min).
  w.setClock('2026-09-05T12:45:00.000Z');
  const rDone = await w.service.completeSession({ ...rbt, authorizationId: 'auth-ABA', memo: 'rbt note' });
  assert.equal(rDone.timeRecord.workedMinutes, 150, 'RBT worked 150 minutes');

  // Independent worked minutes — never combined (would be 240) or copied.
  assert.equal(bDone.timeRecord.workedMinutes, 90);
  assert.equal(rDone.timeRecord.workedMinutes, 150);
  assert.notEqual(bDone.timeRecord.workedMinutes, rDone.timeRecord.workedMinutes);

  // Separate SessionTimeRecords, tied to each clinician's own session.
  assert.notEqual(bDone.timeRecord.id, rDone.timeRecord.id, 'separate SessionTimeRecord ids');
  assert.notEqual(bDone.timeRecord.sessionId, rDone.timeRecord.sessionId, 'records tied to different sessions');
  assert.equal(bDone.timeRecord.staffProfileId, 'bcba-1');
  assert.equal(rDone.timeRecord.staffProfileId, 'rbt-1');
  assert.equal(w.timeRecords.length, 2, 'exactly two records — never one shared appointment record');

  // Payroll inputs independent: each uses its OWN minutes × its OWN rate.
  // BCBA: 90min × $50/hr = $75.00 = 7500 minor. RBT: 150min × $25/hr = $62.50 = 6250 minor.
  assert.equal(bDone.timeRecord.amount, 7500);
  assert.equal(rDone.timeRecord.amount, 6250);

  // BCBA's completed session is unchanged by RBT's completion.
  assert.equal(w.session('bcba-1').status, 'FROZEN');
  assert.equal(new Date(w.session('bcba-1').endedAt).toISOString(), '2026-09-05T11:30:00.000Z');
});

test('§9A — RBT completing first does not finalize the BCBA session', async () => {
  const w = makeWorld();
  const bcba = { tenantId: 't1', actorUserId: 'u-bcba', bcbaStaffProfileId: 'bcba-1', appointmentId: APPT, role: 'BCBA' };
  const rbt = { tenantId: 't1', actorUserId: 'u-rbt', bcbaStaffProfileId: 'rbt-1', appointmentId: APPT, role: 'RBT' };

  w.setClock('2026-09-05T10:00:00.000Z'); await w.service.startSession(bcba);
  w.setClock('2026-09-05T10:30:00.000Z'); await w.service.startSession(rbt);
  w.setClock('2026-09-05T11:00:00.000Z');
  await w.service.completeSession({ ...rbt, authorizationId: 'auth-ABA' });

  assert.equal(w.session('rbt-1').status, 'FROZEN', 'RBT completed');
  assert.equal(w.session('bcba-1').status, 'IN_PROGRESS', 'BCBA remains active');
  assert.equal(w.session('bcba-1').endedAt ?? null, null, 'BCBA worked minutes not finalized by RBT completion');
});
