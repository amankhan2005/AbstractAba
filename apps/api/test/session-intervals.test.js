import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/sessionHarness.js';
import { loadStaffActivity } from '../src/modules/activity/activity.pipeline.js';
import { projectStaffActivity } from '../src/modules/activity/activity.projection.js';

/**
 * ---------------------------------------------------------------------------
 * REPEATED START/STOP IS ONE LOGICAL SESSION (onboarding §10 and §30).
 *
 * The scenario from the onboarding document, run through the REAL
 * BcbaSessionService — not through hand-built data handed to a helper:
 *
 *     09:00 → 09:30
 *     11:00 → 12:00
 *     14:00 → 15:00
 *
 *   expected:  Sessions: 1      Worked Time: 2h 30m
 *              three timing intervals, all still visible in history
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT
 * -------------------------------------
 * PROVES: the service lifecycle. Every assertion below is the result of calling
 * startSession / stopSession / completeSession for real, over ports that
 * reproduce the two index semantics the bug actually lived in (the Session
 * partial-unique index on active:true, and the SessionTimeRecord unique index
 * on sessionId). The session count, the interval history, the summed worked
 * minutes and the payroll amount are all read back from what the service
 * persisted.
 *
 * DOES NOT PROVE: MongoDB behaviour. A live database is not available in this
 * environment (mongodb-memory-server fetches its server binary from a host this
 * environment cannot reach), so index enforcement is reproduced in the harness
 * rather than exercised by the real engine. The aggregation and export layers
 * are covered separately by driving the real projection over the persisted
 * rows, which is the next-best available evidence — see the final test here and
 * payroll-billing-intervals.test.js.
 * ---------------------------------------------------------------------------
 */

const TENANT = 'org1';
const BCBA = 'staff_bcba_1';
const ACTOR = 'user_1';

/** An appointment scheduled for the whole business day of 09/12/2026, New York. */
function dayAppointment(overrides = {}) {
  return {
    id: 'appt_1',
    tenantId: TENANT,
    clientId: 'child1',
    bcbaId: BCBA,
    rbtId: null,
    staffProfileId: BCBA,
    // Business-day anchored: org midnight 09/12 → exclusive org midnight 09/13.
    startAt: new Date('2026-09-12T04:00:00.000Z'),
    endAt: new Date('2026-09-13T04:00:00.000Z'),
    timeSet: false,
    businessTimeZone: 'America/New_York',
    authorizationId: 'auth_1',
    authorizationIds: ['auth_1'],
    units: 8,
    status: 'SCHEDULED',
    ...overrides,
  };
}

/** Drive the three intervals from the onboarding example. Returns the harness. */
async function runThreeIntervals() {
  const h = createHarness({
    timeZone: 'America/New_York',
    now: '2026-09-12T13:00:00.000Z', // 09:00 New York
    hourlyRateDollars: 50,
    appointment: dayAppointment(),
  });
  const call = { tenantId: TENANT, actorUserId: ACTOR, bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  // 09:00 → 09:30
  await h.service.startSession(call);
  h.clock.advanceMinutes(30);
  await h.service.stopSession(call);

  // 11:00 → 12:00 (a 90-minute break, then Start again)
  h.clock.advanceMinutes(90);
  await h.service.startSession(call);
  h.clock.advanceMinutes(60);
  await h.service.stopSession(call);

  // 14:00 → 15:00
  h.clock.advanceMinutes(120);
  await h.service.startSession(call);
  h.clock.advanceMinutes(60);
  await h.service.stopSession(call);

  return { h, call };
}

test('three Start/Stop periods produce ONE session, not three', async () => {
  const { h } = await runThreeIntervals();
  const rows = h.allSessions(TENANT);
  assert.equal(rows.length, 1, 'repeated Start/Stop must not create extra Session rows');
});

test('every timing interval is preserved, none overwritten', async () => {
  const { h } = await runThreeIntervals();
  const [session] = h.allSessions(TENANT);
  const closed = session.intervals.filter((iv) => iv.startedAt && iv.endedAt);
  assert.equal(closed.length, 3, 'all three intervals must remain in history');

  const minutes = closed.map((iv) => Math.round((new Date(iv.endedAt) - new Date(iv.startedAt)) / 60000));
  assert.deepEqual(minutes, [30, 60, 60]);

  // The first interval's start is untouched by the two later ones.
  assert.equal(new Date(closed[0].startedAt).toISOString(), '2026-09-12T13:00:00.000Z');
  // And the session's own startedAt stays at the FIRST start, not the last.
  assert.equal(new Date(session.startedAt).toISOString(), '2026-09-12T13:00:00.000Z');
});

test('worked time is the SUM of the intervals (2h 30m), not the span between them', async () => {
  const { h, call } = await runThreeIntervals();
  const result = await h.service.completeSession({ ...call, authorizationId: 'auth_1', memo: 'Session note' });

  assert.equal(result.timeRecord.workedMinutes, 150, 'expected 30 + 60 + 60 = 150 minutes');
  // The wall-to-wall span from first start to last end is 6 hours. Paying that
  // would bill the client and pay the clinician for two hours of breaks.
  const span = (new Date(result.timeRecord.endedAt) - new Date(result.timeRecord.startedAt)) / 60000;
  assert.equal(span, 360);
  assert.notEqual(result.timeRecord.workedMinutes, span);
});

test('the payroll amount uses the summed worked time at the employee rate', async () => {
  const { h, call } = await runThreeIntervals();
  const { timeRecord } = await h.service.completeSession({ ...call, authorizationId: 'auth_1', memo: 'note' });

  // $50/hour, snapshot in cents-per-hour; 150 minutes = 2.5h = $125.00.
  assert.equal(timeRecord.hourlyRateSnapshot, 5000);
  assert.equal(timeRecord.amount, 12500);
});

test('exactly one SessionTimeRecord is produced, and Complete is idempotent', async () => {
  const { h, call } = await runThreeIntervals();
  const first = await h.service.completeSession({ ...call, authorizationId: 'auth_1', memo: 'note' });
  const second = await h.service.completeSession({ ...call, authorizationId: 'auth_1', memo: 'note' });

  assert.equal(second.alreadyCompleted, true);
  assert.equal(h.allTimeRecords(TENANT).length, 1, 'a repeated Complete must never create a second payroll record');
  assert.equal(second.timeRecord.id, first.timeRecord.id);
  assert.equal(second.timeRecord.workedMinutes, 150);
});

test('a stopped session can be resumed — it is not forced to complete first', async () => {
  const h = createHarness({
    now: '2026-09-12T13:00:00.000Z',
    appointment: dayAppointment(),
  });
  const call = { tenantId: TENANT, actorUserId: ACTOR, bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  await h.service.startSession(call);
  h.clock.advanceMinutes(30);
  await h.service.stopSession(call);

  // This is the regression: Start used to return the stopped session unchanged,
  // so a second interval was impossible without completing and re-starting.
  h.clock.advanceMinutes(30);
  const resumed = await h.service.startSession(call);
  assert.equal(resumed.status, 'IN_PROGRESS');
  assert.equal(resumed.endedAt, null, 'resuming must clear the previous stop');

  const [session] = h.allSessions(TENANT);
  assert.equal(session.intervals.length, 2);
  assert.equal(session.intervals[0].endedAt !== null, true, 'the first interval stays closed');
  assert.equal(session.intervals[1].endedAt, null, 'the second interval is running');
});

test('a repeated Stop does not overwrite the interval already recorded', async () => {
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: ACTOR, bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

  await h.service.startSession(call);
  h.clock.advanceMinutes(45);
  await h.service.stopSession(call);
  const afterFirst = h.allSessions(TENANT)[0].intervals[0].endedAt;

  h.clock.advanceMinutes(60);
  await h.service.stopSession(call);
  const afterSecond = h.allSessions(TENANT)[0].intervals[0].endedAt;

  assert.equal(new Date(afterSecond).toISOString(), new Date(afterFirst).toISOString(),
    'the recorded stop time must not be rewritten by a later Stop');
  assert.equal(h.allSessions(TENANT)[0].intervals.length, 1);
});

test('the session payload exposes the full interval history alongside the total', async () => {
  const { h, call } = await runThreeIntervals();
  const payload = await h.service.stopSession(call); // completion payload for the panel

  assert.equal(payload.workedMinutes, 150);
  assert.equal(payload.durationText, '2h 30m 0s'); // same second-precision format as a single-interval session
  assert.equal(payload.intervalCount, 3);
  assert.deepEqual(payload.intervals.map((iv) => iv.workedMinutes), [30, 60, 60]);
});

test('Payroll and Billing both read ONE session of 150 minutes from the persisted rows', async () => {
  const { h, call } = await runThreeIntervals();
  await h.service.completeSession({ ...call, authorizationId: 'auth_1', memo: 'note' });

  // Feed the persisted rows through the REAL shared projection that Payroll and
  // Billing both build on, exactly as loadStaffActivity would after its queries.
  const [session] = h.allSessions(TENANT);
  const [record] = h.allTimeRecords(TENANT);
  const activities = projectStaffActivity({
    sessions: [{ ...session, _id: session.id }],
    workedById: new Map([[session.id, record.workedMinutes]]),
    apptById: new Map([['appt_1', dayAppointment()]]),
    staffById: new Map([[BCBA, { firstName: 'Ben', lastName: 'Carter' }]]),
    clientById: new Map([['child1', { firstName: 'John', lastName: 'Doe' }]]),
    roleByStaffId: new Map([[BCBA, 'BCBA']]),
    rateByStaffId: new Map([[BCBA, { rateCents: 5000, rateType: 'HOURLY', currency: 'usd' }]]),
  });

  assert.equal(activities.length, 1, 'one logical session must project to one activity row');
  assert.equal(activities[0].workedMinutes, 150);
  assert.equal(activities[0].role, 'BCBA');
  assert.equal(activities[0].intervals.length, 3, 'the timing history survives into the shared projection');
  assert.equal(typeof loadStaffActivity, 'function'); // the pipeline this projection feeds
});

test('the interval sum is still correct when a session has no SessionTimeRecord', async () => {
  // The RBT review-approval path reaches FROZEN without a SessionTimeRecord
  // (onboarding §18). The shared projection must then derive worked time from
  // the session's OWN intervals — not from first-start to last-end.
  const { h } = await runThreeIntervals();
  const [session] = h.allSessions(TENANT);

  const activities = projectStaffActivity({
    sessions: [{ ...session, _id: session.id, status: 'FROZEN' }],
    workedById: new Map(), // no time record at all
    apptById: new Map([['appt_1', dayAppointment({ bcbaId: null, rbtId: BCBA })]]),
    staffById: new Map([[BCBA, { firstName: 'Ann', lastName: 'Lee' }]]),
    clientById: new Map([['child1', { firstName: 'John', lastName: 'Doe' }]]),
    roleByStaffId: new Map([[BCBA, 'RBT']]),
    rateByStaffId: new Map([[BCBA, { rateCents: 2500, rateType: 'HOURLY', currency: 'usd' }]]),
  });

  assert.equal(activities[0].workedMinutes, 150, 'must sum the intervals, not span first-to-last');
  assert.equal(activities[0].role, 'RBT');
});

// --- the read path Session Detail actually uses ------------------------------

test('Session Detail receives the work periods with their own durations', async () => {
  // The panel renders s.intervals[i].workedMinutes, so the read projection —
  // repository mapper through the sessions service presenter — has to carry
  // them. A session whose periods stop at the repository renders an empty
  // history panel, which is exactly the "data exists but is not displayed"
  // failure onboarding §27 warns about.
  const { SessionsService } = await import('../src/modules/sessions/sessions.service.js');
  const { h } = await runThreeIntervals();
  const [stored] = h.allSessions(TENANT);

  const service = new SessionsService({
    repository: {
      findSessionById: async () => ({ ...stored, sensitive: { narrative: null } }),
      listDataPoints: async () => [],
    },
    phi: { seal: (v) => v, open: (v) => v },
  });

  const { session } = await service.getSession({ tenantId: TENANT, sessionId: stored.id });
  assert.equal(session.intervals.length, 3, 'all three work periods reach the detail response');
  assert.deepEqual(session.intervals.map((iv) => iv.workedMinutes), [30, 60, 60]);
  assert.ok(session.intervals.every((iv) => iv.startedAt && iv.endedAt));
});

test('a running work period reports no duration yet, rather than a wrong one', async () => {
  const { SessionsService } = await import('../src/modules/sessions/sessions.service.js');
  const h = createHarness({ now: '2026-09-12T13:00:00.000Z', appointment: dayAppointment() });
  const call = { tenantId: TENANT, actorUserId: ACTOR, bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };
  await h.service.startSession(call);
  h.clock.advanceMinutes(20);
  await h.service.stopSession(call);
  h.clock.advanceMinutes(10);
  await h.service.startSession(call); // second period still running

  const [stored] = h.allSessions(TENANT);
  const service = new SessionsService({
    repository: { findSessionById: async () => ({ ...stored, sensitive: { narrative: null } }), listDataPoints: async () => [] },
    phi: { seal: (v) => v, open: (v) => v },
  });
  const { session } = await service.getSession({ tenantId: TENANT, sessionId: stored.id });

  assert.equal(session.intervals[0].workedMinutes, 20);
  assert.equal(session.intervals[1].workedMinutes, null, 'an open period has no duration yet');
  assert.equal(session.intervals[1].endedAt, null);
});
