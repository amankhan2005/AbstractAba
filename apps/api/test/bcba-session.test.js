import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BcbaSessionService } from '../src/modules/bcba-session/bcbaSession.service.js';
import {
  workedMinutes, payAmountMinor, dollarsToMinor, humanDuration,
} from '../src/modules/bcba-session/bcbaSession.time.js';

/**
 * DB-free tests for the BCBA session workflow. The service is exercised against
 * fake ports (no database), which is the pattern the platform's other service
 * tests use. They lock in the spec's §23 matrix: start validation + idempotency,
 * timer reconstruction from persisted startedAt, exact-timestamp stop, ABA/FBA
 * authorization restriction, memo capture, payroll rate snapshot + amount, and —
 * the headline — no duplicate payroll on a repeated complete (§16).
 */

// --- pure time/pay helpers -------------------------------------------------

test('time helpers: worked minutes, hourly amount, dollars→minor, human duration', () => {
  const start = '2026-09-05T10:31:14.000Z';
  const end = '2026-09-05T11:46:37.000Z'; // 1h 15m 23s
  assert.equal(workedMinutes(start, end), 75); // floored whole minutes
  assert.equal(humanDuration(start, end), '1h 15m 23s'); // seconds preserved (§10)
  assert.equal(dollarsToMinor(30), 3000);
  assert.equal(dollarsToMinor(null), null);
  // 30/hr * 75min = round(3000*75/60) = 3750 cents = $37.50
  assert.equal(payAmountMinor({ hourlyRateMinor: 3000, minutes: 75 }), 3750);
  // No rate configured → null amount, not a throw.
  assert.equal(payAmountMinor({ hourlyRateMinor: null, minutes: 75 }), null);
});

// --- service harness -------------------------------------------------------

const FIXED_NOW = new Date('2026-09-05T11:46:37.000Z');
const START = new Date('2026-09-05T10:31:14.000Z');

function makeService({
  state = 'ACTIVE',
  appointment = {},
  session = null,
  activePlan = { id: 'plan-A' },
  hourlyRateDollars = 30,
  timeRecord = null,
  now = FIXED_NOW,
} = {}) {
  const appt = {
    id: 'appt-1', clientId: 'child-A', bcbaId: 'bcba-1', rbtId: 'rbt-1',
    authorizationId: 'auth-ABA', authorizationIds: ['auth-ABA', 'auth-FBA'],
    startAt: START, endAt: FIXED_NOW, units: 4, status: 'SCHEDULED', ...appointment,
  };
  const store = {
    session: session ? { ...session } : null,
    timeRecords: timeRecord ? [{ ...timeRecord }] : [],
    createdSessions: [], updates: [], freezes: [], createdRecords: [],
  };
  const sealed = (v) => (v == null ? v : `sealed(${v})`);
  const opened = (v) => (typeof v === 'string' && v.startsWith('sealed(') ? v.slice(7, -1) : v);

  const service = new BcbaSessionService({
    clock: { now: () => now },
    organizations: { getById: async () => ({ state }) },
    appointments: {
      findById: async (_t, id) => (id === appt.id ? { ...appt } : null),
      listForBcba: async () => [{ ...appt }],
    },
    sessions: {
      findByAppointment: async () => (store.session ? { ...store.session } : null),
      findById: async () => (store.session ? { ...store.session } : null),
      create: async (_t, doc) => {
        store.createdSessions.push(doc);
        store.session = { id: 'sess-1', version: 1, ...doc };
        return { ...store.session };
      },
      update: async (_t, id, patch) => {
        store.updates.push({ id, patch });
        store.session = { ...store.session, ...patch };
        // sealed narrative arrives under the dotted key
        if (patch['sensitive.narrative'] !== undefined) {
          store.session.sensitive = { narrative: patch['sensitive.narrative'] };
        }
        return { ...store.session };
      },
      freeze: async (_t, id, actor) => {
        store.freezes.push({ id, actor });
        store.session = { ...store.session, status: 'FROZEN', frozenAt: now, frozenBy: actor };
        return { ...store.session };
      },
    },
    plans: {
      findActivePlanForClient: async () => (activePlan ? { ...activePlan } : null),
      summarize: async () => ({ goalCount: 2, programCount: 1 }),
    },
    clients: {
      findById: async (_t, id) => ({ id, clientNumber: 'C-1001', firstName: 'Ada', lastName: 'Byron', dateOfBirth: '2016-05-01', status: 'ACTIVE', pronouns: 'she/her', primaryLanguage: 'en', address: { city: 'Lucknow', state: 'UP' } }),
    },
    authorizations: {
      // Resolves ids (incl. svc: markers) to display objects, mirroring the real
      // resolver. 'svc:sa-1' → a real ABA label; unknown ids → generic label.
      resolveMany: async (_t, ids) => ids.map((id) => (
        id === 'auth-ABA' || id === 'svc:sa-1'
          ? { id, label: 'ABA — ABC Insurance — AUTH-12345', payerName: 'ABC Insurance', authorizationNumber: 'AUTH-12345', serviceCode: 'ABA', remainingUnits: 120, status: 'ACTIVE' }
          : id === 'auth-FBA'
            ? { id, label: 'FBA — ABC Insurance — AUTH-9', payerName: 'ABC Insurance', authorizationNumber: 'AUTH-9', serviceCode: 'FBA', remainingUnits: 40, status: 'ACTIVE' }
            : { id, label: 'Authorization', payerName: null, authorizationNumber: null, serviceCode: null, remainingUnits: null, status: null }
      )),
    },
    payRates: { getCurrentHourlyRate: async () => hourlyRateDollars },
    timeRecords: {
      findBySession: async (_t, sid) => store.timeRecords.find((r) => r.sessionId === sid) ?? null,
      create: async (_t, doc) => {
        // Enforce the unique (session) constraint the DB index guarantees (§16).
        const dup = store.timeRecords.find((r) => r.sessionId === doc.sessionId);
        if (dup) return { ...dup };
        const rec = { id: `tr-${store.timeRecords.length + 1}`, ...doc };
        store.timeRecords.push(rec);
        store.createdRecords.push(rec);
        return { ...rec };
      },
      list: async () => store.timeRecords.map((r) => ({ ...r })),
    },
    phi: { seal: sealed, open: opened },
  });
  return { service, store, appt };
}

const ctx = { tenantId: 't1', actorUserId: 'u-bcba', bcbaStaffProfileId: 'bcba-1' };

// --- START SESSION ---------------------------------------------------------

test('start: valid BCBA + valid appointment → session starts IN_PROGRESS with server startedAt', async () => {
  const { service, store } = makeService();
  const s = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(s.status, 'IN_PROGRESS');
  assert.equal(store.createdSessions.length, 1);
  assert.equal(store.createdSessions[0].staffProfileId, 'bcba-1'); // BCBA is the deliverer
  assert.equal(store.createdSessions[0].treatmentPlanId, 'plan-A');
  assert.equal(new Date(s.startedAt).toISOString(), FIXED_NOW.toISOString()); // server clock
});

test('start: wrong BCBA → NOT_YOUR_APPOINTMENT (403)', async () => {
  const { service } = makeService({ appointment: { bcbaId: 'someone-else' } });
  await assert.rejects(
    () => service.startSession({ ...ctx, appointmentId: 'appt-1' }),
    (e) => e.code === 'NOT_YOUR_APPOINTMENT' && e.status === 403,
  );
});

test('start: org not active → ORG_NOT_ACTIVE (409)', async () => {
  const { service } = makeService({ state: 'SUSPENDED' });
  await assert.rejects(
    () => service.startSession({ ...ctx, appointmentId: 'appt-1' }),
    (e) => e.code === 'ORG_NOT_ACTIVE' && e.status === 409,
  );
});

test('start: NO treatment plan does NOT block start (409 fix) — session starts with null plan', async () => {
  const { service, store } = makeService({ activePlan: null });
  const s = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(s.status, 'IN_PROGRESS');
  assert.equal(store.createdSessions.length, 1);
  assert.equal(store.createdSessions[0].treatmentPlanId, null, 'session starts unbound to a plan');
});

test('start: an ACTIVE plan is bound when one exists', async () => {
  const { service, store } = makeService({ activePlan: { id: 'plan-A', status: 'ACTIVE' } });
  await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(store.createdSessions[0].treatmentPlanId, 'plan-A');
});

test('active: a plan created mid-session is backfilled onto the running session (Part 13)', async () => {
  const { service, store } = makeService({
    activePlan: { id: 'plan-new', status: 'ACTIVE' },
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: null, treatmentPlanId: null, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const s = await service.getActiveByAppointment({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(s.treatmentPlanId, 'plan-new', 'the newly ACTIVE plan is bound to the running session');
  assert.ok(store.updates.some((u) => u.patch.treatmentPlanId === 'plan-new'));
});

test('start: already IN_PROGRESS → returns SAME session, no duplicate created (§3)', async () => {
  const { service, store } = makeService({
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const s = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(s.id, 'sess-1');
  assert.equal(store.createdSessions.length, 0); // no second session
  assert.equal(new Date(s.startedAt).toISOString(), START.toISOString()); // timer not reset
});

test('start: already COMPLETED → SESSION_ALREADY_COMPLETED', async () => {
  const { service } = makeService({ session: { id: 'sess-1', status: 'FROZEN', startedAt: START } });
  await assert.rejects(
    () => service.startSession({ ...ctx, appointmentId: 'appt-1' }),
    (e) => e.code === 'SESSION_ALREADY_COMPLETED',
  );
});

// --- TIMER RECONSTRUCTION --------------------------------------------------

test('active session survives "refresh": startedAt is the persisted server time, not reset', async () => {
  const { service } = makeService({
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const s = await service.getActiveByAppointment({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(new Date(s.startedAt).toISOString(), START.toISOString());
  assert.equal(s.status, 'IN_PROGRESS');
});

// --- STOP SESSION ----------------------------------------------------------

test('stop: sets server endedAt and returns exact timestamps + duration with seconds (§9,§10)', async () => {
  const { service } = makeService({
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: null, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const payload = await service.stopSession({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(new Date(payload.startedAt).toISOString(), START.toISOString());
  assert.equal(new Date(payload.endedAt).toISOString(), FIXED_NOW.toISOString());
  assert.equal(payload.durationText, '1h 15m 23s');
  assert.equal(payload.workedMinutes, 75);
  // Normalized, user-facing options (spec §10/§11) — never raw ids as labels.
  assert.deepEqual(payload.eligibleAuthorizations.map((a) => a.label), ['ABA — ABC Insurance — AUTH-12345', 'FBA — ABC Insurance — AUTH-9']);
  assert.deepEqual(payload.eligibleAuthorizationIds, ['auth-ABA', 'auth-FBA']); // ids kept internally for validation
});

// --- AUTHORIZATION SELECTION ----------------------------------------------

test('complete: authorization not bound to appointment → INVALID_AUTHORIZATION (422)', async () => {
  const { service } = makeService({
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: FIXED_NOW, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  await assert.rejects(
    () => service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-OTHER-CHILD', memo: 'x' }),
    (e) => e.code === 'INVALID_AUTHORIZATION' && e.status === 422,
  );
});

// --- COMPLETE + PAYROLL ----------------------------------------------------

test('complete: freezes session, snapshots rate, computes amount, records memo capture', async () => {
  const { service, store } = makeService({
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: FIXED_NOW, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const { session, timeRecord, alreadyCompleted } = await service.completeSession({
    ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-FBA', memo: 'Worked on FCT and transitions.',
  });
  assert.equal(alreadyCompleted, false);
  assert.equal(session.status, 'FROZEN'); // COMPLETED
  assert.equal(store.freezes.length, 1);
  assert.equal(timeRecord.workedMinutes, 75);
  assert.equal(timeRecord.hourlyRateSnapshot, 3000); // $30 → 3000 cents snapshot (§14)
  assert.equal(timeRecord.amount, 3750); // 75min @ $30/hr = $37.50
  assert.equal(timeRecord.authorizationId, 'auth-FBA'); // the selected one
  assert.equal(timeRecord.memoCaptured, true);
  assert.equal(store.createdRecords.length, 1);
});

test('complete: NO rate configured → completes with null amount, still one record (§13 edge)', async () => {
  const { service } = makeService({
    hourlyRateDollars: null,
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: FIXED_NOW, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const { timeRecord } = await service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-ABA' });
  assert.equal(timeRecord.hourlyRateSnapshot, null);
  assert.equal(timeRecord.amount, null);
});

// --- DUPLICATE PAYROLL PROTECTION (§16, the critical one) ------------------

test('complete twice → NO duplicate payroll record; second call returns existing', async () => {
  const { service, store } = makeService({
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: FIXED_NOW, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const first = await service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-ABA', memo: 'note' });
  // Session is now FROZEN; a repeat (double-click / retry) must be idempotent.
  const second = await service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-ABA', memo: 'note' });
  assert.equal(store.createdRecords.length, 1); // exactly ONE payroll record ever
  assert.equal(second.alreadyCompleted, true);
  assert.equal(second.timeRecord.id, first.timeRecord.id);
  assert.equal(store.freezes.length, 1); // freeze not repeated
});

test('complete: partial finalize recovery — FROZEN session with no record gets its record (§17)', async () => {
  // Session already FROZEN (a prior finalize froze it) but the payroll record
  // never landed. A retry must create the missing record, not skip it.
  const { service, store } = makeService({
    session: { id: 'sess-1', status: 'FROZEN', startedAt: START, endedAt: FIXED_NOW, clientId: 'child-A', staffProfileId: 'bcba-1', selectedAuthorizationId: 'auth-ABA' },
    timeRecord: null,
  });
  const { timeRecord, alreadyCompleted } = await service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'auth-ABA' });
  assert.equal(alreadyCompleted, true);
  assert.equal(store.createdRecords.length, 1);
  assert.equal(timeRecord.workedMinutes, 75);
});

// --- PANEL -----------------------------------------------------------------

test('panel: card carries START affordance when no session, running when IN_PROGRESS', async () => {
  const scheduled = makeService();
  const cardsA = await scheduled.service.listPanel({ tenantId: 't1', bcbaStaffProfileId: 'bcba-1' });
  assert.equal(cardsA[0].sessionStatus, 'SCHEDULED');
  assert.equal(cardsA[0].canStart, true);
  assert.equal(cardsA[0].isRunning, false);

  const running = makeService({ session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: null } });
  const cardsB = await running.service.listPanel({ tenantId: 't1', bcbaStaffProfileId: 'bcba-1' });
  assert.equal(cardsB[0].sessionStatus, 'IN_PROGRESS');
  assert.equal(cardsB[0].isRunning, true);
  assert.equal(cardsB[0].canStart, false);
});

test('missing staff profile → MISSING_STAFF_PROFILE (a BCBA with no clinician link cannot run sessions)', async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.startSession({ tenantId: 't1', actorUserId: 'u', bcbaStaffProfileId: null, appointmentId: 'appt-1' }),
    (e) => e.code === 'MISSING_STAFF_PROFILE',
  );
});

// ==========================================================================
// SECURITY — strict BCBA ownership by appointment.bcbaId (spec Part 2, 22, 24)
// ==========================================================================

test('SEC Test 1: BCBA A sees their own appointment (bcbaId === A)', async () => {
  const { service } = makeService(); // appt.bcbaId = 'bcba-1', ctx = bcba-1
  const cards = await service.listPanel({ tenantId: 't1', bcbaStaffProfileId: 'bcba-1' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].appointmentId, 'appt-1');
});

test('SEC Test 2/5: BCBA A cannot start BCBA B\u2019s appointment → NOT_YOUR_APPOINTMENT (403)', async () => {
  const { service } = makeService({ appointment: { bcbaId: 'bcba-2' } });
  await assert.rejects(
    () => service.startSession({ ...ctx, appointmentId: 'appt-1' }),
    (e) => e.code === 'NOT_YOUR_APPOINTMENT' && e.status === 403,
  );
});

test('SEC Test 3: BCBA A manually requesting BCBA B\u2019s appointment id is rejected (getActive)', async () => {
  const { service } = makeService({ appointment: { bcbaId: 'bcba-2' } });
  await assert.rejects(
    () => service.getActiveByAppointment({ ...ctx, appointmentId: 'appt-1' }),
    (e) => e.code === 'NOT_YOUR_APPOINTMENT',
  );
});

test('SEC Test 4: BCBA A cannot read BCBA B\u2019s child detail (ownership-scoped)', async () => {
  const { service } = makeService({ appointment: { bcbaId: 'bcba-2', clientId: 'child-B' } });
  await assert.rejects(
    () => service.getChildDetail({ ...ctx, appointmentId: 'appt-1' }),
    (e) => e.code === 'NOT_YOUR_APPOINTMENT',
  );
});

test('SEC Test 6: ownership uses bcbaId, NOT the legacy staffProfileId (which is the RBT)', async () => {
  // Appointment: bcbaId = the acting BCBA, but staffProfileId (legacy) = the RBT.
  // The BCBA must still be able to start it — ownership must not be confused
  // with staffProfileId.
  const { service, store } = makeService({ appointment: { bcbaId: 'bcba-1', rbtId: 'rbt-1', staffProfileId: 'rbt-1' } });
  const s = await service.startSession({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(s.status, 'IN_PROGRESS');
  assert.equal(store.createdSessions.length, 1);
});

// ==========================================================================
// CHILD DETAIL — clean, permission-scoped overview (spec Part 5, 6)
// ==========================================================================

test('child detail: returns a clean child + appointment + plan overview, no SSN', async () => {
  const { service } = makeService({
    activePlan: { id: 'plan-A', status: 'ACTIVE', title: 'Q3 Plan' },
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: null, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const d = await service.getChildDetail({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(d.child.firstName, 'Ada');
  assert.equal(d.child.age, new Date().getFullYear() - 2016 - (new Date() < new Date(new Date().getFullYear(), 4, 1) ? 1 : 0));
  assert.equal(d.appointment.rbtId, 'rbt-1');
  assert.deepEqual(d.appointment.authorizationIds, ['auth-ABA', 'auth-FBA']);
  assert.equal(d.activePlan.title, 'Q3 Plan');
  assert.equal(d.activePlan.goalCount, 2);
  assert.equal(d.session.status, 'IN_PROGRESS');
  assert.ok(!('ssn' in d.child) && !('sensitive' in d.child), 'no sensitive identifiers leak');
});

test('child detail: works with no plan and no session (fresh appointment)', async () => {
  const { service } = makeService({ activePlan: null });
  const d = await service.getChildDetail({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(d.activePlan, null);
  assert.equal(d.session, null);
  assert.equal(d.child.firstName, 'Ada');
});

// ==========================================================================
// AUTHORIZATION RESOLUTION — no raw svc:<id> ever reaches the UI (spec §10/§11)
// ==========================================================================

test('svc: authorization id resolves to a real label in the stop payload', async () => {
  const { service } = makeService({
    appointment: { authorizationIds: ['svc:sa-1'] },
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: FIXED_NOW, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const payload = await service.stopSession({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(payload.eligibleAuthorizations[0].id, 'svc:sa-1', 'internal id preserved as the option value');
  assert.equal(payload.eligibleAuthorizations[0].label, 'ABA — ABC Insurance — AUTH-12345');
  assert.ok(!payload.eligibleAuthorizations[0].label.startsWith('svc:'), 'no raw svc: marker in the label');
});

test('completeSession returns the resolved selected authorization (real label, not svc:)', async () => {
  const { service } = makeService({
    appointment: { authorizationIds: ['svc:sa-1', 'auth-FBA'] },
    session: { id: 'sess-1', status: 'IN_PROGRESS', startedAt: START, endedAt: FIXED_NOW, clientId: 'child-A', staffProfileId: 'bcba-1' },
  });
  const { authorization } = await service.completeSession({ ...ctx, appointmentId: 'appt-1', authorizationId: 'svc:sa-1', memo: 'x' });
  assert.equal(authorization.label, 'ABA — ABC Insurance — AUTH-12345');
  assert.equal(authorization.authorizationNumber, 'AUTH-12345');
});

test('child detail exposes resolved authorizations (display objects, not raw ids)', async () => {
  const { service } = makeService({ appointment: { authorizationIds: ['svc:sa-1'] } });
  const d = await service.getChildDetail({ ...ctx, appointmentId: 'appt-1' });
  assert.equal(d.appointment.authorizations[0].label, 'ABA — ABC Insurance — AUTH-12345');
  assert.deepEqual(d.appointment.authorizationIds, ['svc:sa-1']); // raw id still available internally
});
