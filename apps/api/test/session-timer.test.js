import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/sessionHarness.js';

/**
 * ---------------------------------------------------------------------------
 * SESSION TIMER LIFECYCLE.
 *
 * The timer is not a frontend concern: what it displays is whatever instant the
 * server says the CURRENT work period started at. So these tests drive the real
 * BcbaSessionService and assert on the value the panel actually hands the
 * browser — `activePeriodStartedAt`.
 *
 * THE BUG THESE COVER. The timer was anchored on `card.startedAt`, the start of
 * the whole logical session, which deliberately never moves. After a Stop and a
 * restart it is hours behind the work in progress: a clinician who worked
 * 09:00-09:30, broke until 11:00 and restarted saw 2:10 ten minutes into the
 * second period, counting the break as time on the clock. Anchoring on the open
 * work period fixes it, and because that instant is persisted, a refresh
 * reconstructs the elapsed time rather than restarting from zero.
 * ---------------------------------------------------------------------------
 */

const TENANT = 'org1';
const BCBA = 'staff_bcba';
const RBT = 'staff_rbt';

function dayAppointment(overrides = {}) {
  return {
    id: 'appt_1', tenantId: TENANT, clientId: 'child1',
    bcbaId: BCBA, rbtId: null, staffProfileId: BCBA,
    startAt: new Date('2026-09-12T04:00:00.000Z'),   // org midnight 09/12 New York
    endAt: new Date('2026-09-13T04:00:00.000Z'),
    timeSet: false, businessTimeZone: 'America/New_York',
    authorizationId: 'auth_1', authorizationIds: ['auth_1'], units: 8, status: 'SCHEDULED',
    ...overrides,
  };
}

/** Elapsed minutes a browser would render, given the card and the wall clock. */
const timerMinutes = (card, now) =>
  Math.round((new Date(now).getTime() - new Date(card.activePeriodStartedAt).getTime()) / 60000);

/**
 * BCBA and RBT share ONE session service; the role is a parameter, not a second
 * implementation. Reading both panels through the same call is the point — it is
 * what guarantees the two roles cannot drift apart in timing behaviour.
 */
const panelCard = async (h, staffProfileId, role = 'BCBA') => {
  const cards = await h.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: staffProfileId, role });
  return cards[0];
};

// TEST 1 ---------------------------------------------------------------------
test('BCBA starts a session → the panel carries a running anchor with real elapsed time', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  await h.service.startSession({ tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' });

  h.clock.advanceMinutes(37);
  const card = await panelCard(h, BCBA);

  assert.equal(card.isRunning, true);
  assert.ok(card.activePeriodStartedAt, 'the panel must tell the browser when the running period started');
  assert.equal(timerMinutes(card, h.clock.now()), 37, 'timer should read 0:37');
});

// TEST 2 ---------------------------------------------------------------------
test('RBT starts a session → identical timing contract, on the RBT panel', async () => {
  const appt = dayAppointment({ bcbaId: null, rbtId: RBT, staffProfileId: RBT });
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: appt });
  await h.service.startSession({ tenantId: TENANT, actorUserId: 'u2', bcbaStaffProfileId: RBT, appointmentId: 'appt_1', role: 'RBT' });

  h.clock.advanceMinutes(37);
  const card = await panelCard(h, RBT, 'RBT');

  assert.equal(card.isRunning, true);
  assert.equal(timerMinutes(card, h.clock.now()), 37, 'the RBT timer must behave exactly like the BCBA timer');
});

// TEST 3 ---------------------------------------------------------------------
test('a refresh or navigation does not reset the timer — the anchor is persisted', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  await h.service.startSession({ tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' });

  h.clock.advanceMinutes(27);
  // A refresh is simply another panel read — no browser state is carried over.
  const first = await panelCard(h, BCBA);
  const second = await panelCard(h, BCBA);

  assert.equal(
    new Date(first.activePeriodStartedAt).toISOString(),
    new Date(second.activePeriodStartedAt).toISOString(),
    'the anchor must be identical across reads',
  );
  assert.equal(timerMinutes(second, h.clock.now()), 27, 'a fresh page load must show 0:27, not 0:00');
});

// TEST 4 ---------------------------------------------------------------------
test('Stop ends the running timer — no anchor is offered while stopped', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };
  await h.service.startSession(call);
  h.clock.advanceMinutes(30);
  await h.service.stopSession(call);

  const card = await panelCard(h, BCBA);
  assert.equal(card.isRunning, false);
  assert.equal(card.sessionStatus, 'STOPPED');
  assert.equal(card.activePeriodStartedAt, null, 'a stopped session must not present a running timer');
  assert.equal(card.workedMinutes, 30);
});

// TEST 5 ---------------------------------------------------------------------
test('restart opens a NEW work period on the SAME session, and the timer follows it', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  await h.service.startSession(call);
  h.clock.advanceMinutes(30);
  await h.service.stopSession(call);
  h.clock.advanceMinutes(90);            // a 90-minute break
  await h.service.startSession(call);    // restart
  h.clock.advanceMinutes(10);

  const card = await panelCard(h, BCBA);
  assert.equal(h.allSessions(TENANT).length, 1, 'restart must not create a second session');
  assert.equal(card.isRunning, true);

  // THE REGRESSION: anchoring on the session start would read 2:10 here.
  assert.equal(timerMinutes(card, h.clock.now()), 10, 'the timer shows the CURRENT work period');
  const wrongAnchor = Math.round((h.clock.now().getTime() - new Date(card.startedAt).getTime()) / 60000);
  assert.equal(wrongAnchor, 130, 'the session start is genuinely 2h10m back — proving the anchors differ');
  assert.equal(card.workedMinutes, 30, 'completed periods so far, excluding the running one');
});

// TEST 6 & 7 -----------------------------------------------------------------
test('three work periods stay ONE session, and the total is the sum (2h 30m)', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  await h.service.startSession(call); h.clock.advanceMinutes(30); await h.service.stopSession(call);
  h.clock.advanceMinutes(90);
  await h.service.startSession(call); h.clock.advanceMinutes(60); await h.service.stopSession(call);
  h.clock.advanceMinutes(120);
  await h.service.startSession(call); h.clock.advanceMinutes(60); await h.service.stopSession(call);

  assert.equal(h.allSessions(TENANT).length, 1, 'ONE logical session');
  const card = await panelCard(h, BCBA);
  assert.equal(card.intervalCount, 3, 'three work periods preserved');
  assert.equal(card.workedMinutes, 150, '30 + 60 + 60 = 2h 30m');
  assert.equal(card.activePeriodStartedAt, null, 'stopped — no running timer');

  const { timeRecord } = await h.service.completeSession({ ...call, authorizationId: 'auth_1', memo: 'note' });
  assert.equal(timeRecord.workedMinutes, 150, 'payroll and billing read the same total');
});

// TEST 12 --------------------------------------------------------------------
test('BCBA and RBT session ownership stays isolated', async () => {
  const appt = dayAppointment({ bcbaId: BCBA, rbtId: RBT });
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: appt });

  await h.service.startSession({ tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' });

  // The RBT cannot stop or complete the BCBA's session; starting gives the RBT
  // their OWN session on the same appointment.
  await h.service.startSession({ tenantId: TENANT, actorUserId: 'u2', bcbaStaffProfileId: RBT, appointmentId: 'appt_1', role: 'RBT' });
  const rows = h.allSessions(TENANT);
  assert.equal(rows.length, 2, 'two independent clinicians, two independent sessions');
  assert.notEqual(rows[0].staffProfileId, rows[1].staffProfileId);

  // A clinician who is not assigned to the appointment at all is refused.
  await assert.rejects(
    () => h.service.startSession({ tenantId: TENANT, actorUserId: 'u3', bcbaStaffProfileId: 'someone_else', appointmentId: 'appt_1' }),
    (e) => e.code === 'NOT_YOUR_APPOINTMENT',
  );
});

test('a tenant cannot read another tenant\'s running session', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  await h.service.startSession({ tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' });
  assert.equal(h.allSessions('other_org').length, 0, 'sessions are tenant-scoped');
});

// --- role split, enforced on the SERVER --------------------------------------

test('an RBT cannot write BCBA clinical documentation — rejected, not silently dropped', async () => {
  const appt = dayAppointment({ bcbaId: null, rbtId: RBT, staffProfileId: RBT });
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: appt });
  const call = { tenantId: TENANT, actorUserId: 'u2', bcbaStaffProfileId: RBT, appointmentId: 'appt_1', role: 'RBT' };
  await h.service.startSession(call);

  await assert.rejects(
    () => h.service.saveDocumentation({ ...call, documentation: { what: 'x', how: 'y', childResponse: 'z' } }),
    (e) => e.code === 'DOCUMENTATION_NOT_PERMITTED',
    'the three-field clinical documentation is the BCBA workflow',
  );

  // Nothing was half-written.
  const [session] = h.allSessions(TENANT);
  assert.equal(session.documentation?.what ?? null, null);
});

test('the RBT session memo saves, and survives a reload', async () => {
  const appt = dayAppointment({ bcbaId: null, rbtId: RBT, staffProfileId: RBT });
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: appt });
  const call = { tenantId: TENANT, actorUserId: 'u2', bcbaStaffProfileId: RBT, appointmentId: 'appt_1', role: 'RBT' };
  await h.service.startSession(call);

  const saved = await h.service.saveDocumentation({ ...call, documentation: { memo: 'Client engaged throughout.' } });
  assert.equal(saved.memo, 'Client engaged throughout.');

  // A "reload" is another read of the persisted session — no client state.
  const reread = await h.service.getActiveByAppointment({
    tenantId: TENANT, bcbaStaffProfileId: RBT, appointmentId: 'appt_1', role: 'RBT',
  });
  assert.equal(reread.memo, 'Client engaged throughout.', 'the memo must survive a reload');
});

test('the memo survives Stop and stays attached through completion', async () => {
  const appt = dayAppointment({ bcbaId: null, rbtId: RBT, staffProfileId: RBT });
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: appt });
  const call = { tenantId: TENANT, actorUserId: 'u2', bcbaStaffProfileId: RBT, appointmentId: 'appt_1', role: 'RBT' };

  await h.service.startSession(call);
  await h.service.saveDocumentation({ ...call, documentation: { memo: 'Tolerated transitions well.' } });
  h.clock.advanceMinutes(45);
  await h.service.stopSession(call);

  const [afterStop] = h.allSessions(TENANT);
  assert.ok(afterStop.sensitive?.narrative, 'stopping the timer must not clear the memo');

  await h.service.completeSession({ ...call, authorizationId: 'auth_1' });
  const [afterComplete] = h.allSessions(TENANT);
  assert.ok(afterComplete.sensitive?.narrative, 'the memo stays attached to the completed session');
});

test('a BCBA may write both documentation and a memo', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };
  await h.service.startSession(call);

  const saved = await h.service.saveDocumentation({
    ...call,
    documentation: { what: 'Mands', how: 'Errorless prompting', childResponse: 'Independent requests', memo: 'Good session.' },
  });
  assert.equal(saved.documentation.what, 'Mands');
  assert.equal(saved.documentation.how, 'Errorless prompting');
  assert.equal(saved.documentation.childResponse, 'Independent requests');
  assert.equal(saved.memo, 'Good session.');
});

// --- double-click / retry safety ---------------------------------------------

test('a double-clicked Start creates ONE session and ONE work period', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  await h.service.startSession(call);
  await h.service.startSession(call);   // the second click
  await h.service.startSession(call);   // and a retry

  assert.equal(h.allSessions(TENANT).length, 1, 'no duplicate session');
  const [session] = h.allSessions(TENANT);
  assert.equal(session.intervals.length, 1, 'no duplicate work period');
});

test('a double-clicked Stop does not rewrite the end time or add a record', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  await h.service.startSession(call);
  h.clock.advanceMinutes(25);
  await h.service.stopSession(call);
  const firstEnd = h.allSessions(TENANT)[0].intervals[0].endedAt;

  h.clock.advanceMinutes(15);
  await h.service.stopSession(call);    // the second click, 15 minutes later

  const [session] = h.allSessions(TENANT);
  assert.equal(new Date(session.intervals[0].endedAt).toISOString(), new Date(firstEnd).toISOString(),
    'the recorded end time must not move');
  assert.equal(session.intervals.length, 1);
  assert.equal(h.allTimeRecords(TENANT).length, 0, 'stopping is not completing');
});

test('an already-running session is returned, never duplicated, when Start is pressed again', async () => {
  // The server is authoritative: a stale tab pressing Start must resolve to the
  // session that already exists rather than opening a conflicting one.
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  const first = await h.service.startSession(call);
  h.clock.advanceMinutes(12);
  const second = await h.service.startSession(call);

  assert.equal(second.id, first.id, 'the same session is handed back');
  assert.equal(h.allSessions(TENANT).length, 1);
  // The anchor did NOT move, so a second tab shows the true elapsed time.
  const card = await panelCard(h, BCBA);
  assert.equal(timerMinutes(card, h.clock.now()), 12, 'a stale tab must not restart the clock');
});

// --- BCBA Import from Documentation (§12) ------------------------------------

test('the completion payload carries the PERSISTED documentation that Import reads', async () => {
  // "Import from Session Note" copies the saved documentation into the
  // per-authorization memo. It must read what the SERVER persisted, not
  // whatever happens to be in a form field, so this asserts the round trip:
  // save → stop → the payload the completion screen receives.
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  await h.service.startSession(call);
  await h.service.saveDocumentation({
    ...call,
    documentation: {
      what: 'Manding practice',
      how: 'Errorless prompting with fading',
      childResponse: 'Twelve independent requests',
      memo: 'Strong session overall.',
    },
  });
  h.clock.advanceMinutes(60);
  const payload = await h.service.stopSession(call);

  assert.equal(payload.documentation.what, 'Manding practice');
  assert.equal(payload.documentation.how, 'Errorless prompting with fading');
  assert.equal(payload.documentation.childResponse, 'Twelve independent requests');

  // The text Import composes is built from these three fields; if any were
  // empty the button is disabled rather than importing a blank note.
  const composed = [payload.documentation.what, payload.documentation.how, payload.documentation.childResponse]
    .filter(Boolean);
  assert.equal(composed.length, 3, 'all three fields reach the import source');
});

test('documentation survives Stop, restart and a second work period', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  await h.service.startSession(call);
  await h.service.saveDocumentation({ ...call, documentation: { what: 'Morning block', memo: 'Went well.' } });
  h.clock.advanceMinutes(30);
  await h.service.stopSession(call);
  h.clock.advanceMinutes(90);
  await h.service.startSession(call);           // second work period
  await h.service.saveDocumentation({ ...call, documentation: { how: 'Added prompting' } });
  h.clock.advanceMinutes(60);
  const payload = await h.service.stopSession(call);

  // Nothing written in the first period was lost by restarting.
  assert.equal(payload.documentation.what, 'Morning block');
  assert.equal(payload.documentation.how, 'Added prompting');
  assert.equal(payload.memo, 'Went well.');
  assert.equal(payload.workedMinutes, 90, '30 + 60, excluding the 90-minute break');
});

test('repeated saves overwrite in place — they never accumulate duplicates', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };
  await h.service.startSession(call);

  await h.service.saveDocumentation({ ...call, documentation: { what: 'First' } });
  await h.service.saveDocumentation({ ...call, documentation: { what: 'Second' } });
  const third = await h.service.saveDocumentation({ ...call, documentation: { what: 'Third' } });

  assert.equal(third.documentation.what, 'Third');
  assert.equal(h.allSessions(TENANT).length, 1, 'no duplicate documentation records');
});
