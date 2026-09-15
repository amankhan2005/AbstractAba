import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/sessionHarness.js';
import { projectStaffActivity } from '../src/modules/activity/activity.projection.js';
import { aggregatePeriodPayroll } from '../src/modules/payroll/payroll.periods.js';

/**
 * ---------------------------------------------------------------------------
 * THE FULL BUSINESS SCENARIO, END TO END.
 *
 *   Client: Raymond K
 *   BCBA (rate $50/hr): 09:00-09:30, 11:00-12:00, 14:00-15:00
 *   RBT  (rate $25/hr): 10:00-11:00, 13:00-14:30
 *
 * Expected:
 *   BCBA  1 logical session, 3 work periods, 2h30m, $125.00
 *   RBT   1 logical session, 2 work periods, 2h30m, $62.50
 *   Company payroll total $187.50
 *
 * Run through the REAL BcbaSessionService (start/stop/restart/complete), then
 * through the REAL shared activity projection and the REAL payroll aggregation.
 * Nothing is hand-built except the appointments and the rate configuration.
 *
 * ONE clinician per appointment (§31 of the scheduling spec), so the same client
 * on the same day is two appointments whose sessions stay independent. Their
 * timings overlap deliberately — the BCBA's 11:00-12:00 straddles the RBT's
 * 10:00-11:00 boundary — because merging them is exactly the failure this
 * guards against.
 * ---------------------------------------------------------------------------
 */

const TENANT = 'org1';
const BCBA = 'staff_bcba';
const RBT = 'staff_rbt';
const CLIENT = 'client_raymond';

/** Org midnight 09/12/2026 in New York, as the booking core would store it. */
const DAY_START = new Date('2026-09-12T04:00:00.000Z');
const DAY_END = new Date('2026-09-13T04:00:00.000Z');
/** An org-local wall clock on that business day. */
const at = (h, m = 0) => new Date(DAY_START.getTime() + (h * 60 + m) * 60000);

function appointmentFor(role) {
  const isBcba = role === 'BCBA';
  return {
    id: isBcba ? 'appt_bcba' : 'appt_rbt',
    tenantId: TENANT,
    clientId: CLIENT,
    bcbaId: isBcba ? BCBA : null,
    rbtId: isBcba ? null : RBT,
    staffProfileId: isBcba ? BCBA : RBT,
    startAt: DAY_START,
    endAt: DAY_END,
    timeSet: false,
    businessTimeZone: 'America/New_York',
    authorizationId: isBcba ? 'auth_97155' : 'auth_97153',
    authorizationIds: [isBcba ? 'auth_97155' : 'auth_97153'],
    units: 8,
    status: 'SCHEDULED',
  };
}

/**
 * Work one clinician's day: a list of [startHour, endHour] org-local periods,
 * driven through real Start/Stop calls with the clock moved between them.
 */
async function workDay({ role, staffProfileId, rateDollars, periods, harness }) {
  const appointment = appointmentFor(role);
  const h = harness ?? createHarness({
    timeZone: 'America/New_York',
    now: at(periods[0][0], periods[0][1] ?? 0).toISOString(),
    hourlyRateDollars: rateDollars,
    appointment,
  });
  if (harness) harness.addAppointment(appointment);
  const call = {
    tenantId: TENANT, actorUserId: `user_${staffProfileId}`,
    bcbaStaffProfileId: staffProfileId, appointmentId: appointment.id, role,
  };

  for (const [startH, startM, endH, endM] of periods) {
    h.clock.set(at(startH, startM).toISOString());
    await h.service.startSession(call);
    h.clock.set(at(endH, endM).toISOString());
    await h.service.stopSession(call);
  }

  const completion = await h.service.completeSession({ ...call, authorizationId: appointment.authorizationId, memo: 'Session note' });
  return { harness: h, completion, appointment, call };
}

// [startHour, startMinute, endHour, endMinute]
const BCBA_PERIODS = [[9, 0, 9, 30], [11, 0, 12, 0], [14, 0, 15, 0]];   // 30 + 60 + 60 = 150
const RBT_PERIODS = [[10, 0, 11, 0], [13, 0, 14, 30]];                  // 60 + 90 = 150

test('BCBA: three work periods → ONE session, 2h30m, $125.00', async () => {
  const { harness, completion } = await workDay({
    role: 'BCBA', staffProfileId: BCBA, rateDollars: 50, periods: BCBA_PERIODS,
  });

  assert.equal(harness.allSessions(TENANT).length, 1, 'one logical session');
  const [session] = harness.allSessions(TENANT);
  assert.equal(session.intervals.filter((i) => i.endedAt).length, 3, 'three work periods preserved');
  assert.equal(completion.timeRecord.workedMinutes, 150);
  assert.equal(completion.timeRecord.hourlyRateSnapshot, 5000, '$50/hr');
  assert.equal(completion.timeRecord.amount, 12500, '$125.00');

  // First start to last end is SIX hours. Paying that would pay for the breaks.
  const span = (new Date(completion.timeRecord.endedAt) - new Date(completion.timeRecord.startedAt)) / 60000;
  assert.equal(span, 360);
  assert.notEqual(completion.timeRecord.workedMinutes, span);
});

test('RBT: two work periods → ONE session, 2h30m, $62.50', async () => {
  const { harness, completion } = await workDay({
    role: 'RBT', staffProfileId: RBT, rateDollars: 25, periods: RBT_PERIODS,
  });

  assert.equal(harness.allSessions(TENANT).length, 1, 'one logical session');
  const [session] = harness.allSessions(TENANT);
  assert.equal(session.intervals.filter((i) => i.endedAt).length, 2, 'two work periods preserved');
  assert.equal(completion.timeRecord.workedMinutes, 150);
  assert.equal(completion.timeRecord.hourlyRateSnapshot, 2500, '$25/hr');
  assert.equal(completion.timeRecord.amount, 6250, '$62.50');
});

test('payroll: BCBA $125 + RBT $62.50 = $187.50, each at their OWN rate', async () => {
  const bcba = await workDay({ role: 'BCBA', staffProfileId: BCBA, rateDollars: 50, periods: BCBA_PERIODS });
  const rbt = await workDay({ role: 'RBT', staffProfileId: RBT, rateDollars: 25, periods: RBT_PERIODS });

  // Both clinicians' persisted sessions, through the REAL shared projection.
  const sessions = [
    { ...bcba.harness.allSessions(TENANT)[0] },
    { ...rbt.harness.allSessions(TENANT)[0] },
  ].map((s) => ({ ...s, _id: s.id }));
  const worked = new Map([
    [sessions[0].id, bcba.completion.timeRecord.workedMinutes],
    [sessions[1].id, rbt.completion.timeRecord.workedMinutes],
  ]);

  const activities = projectStaffActivity({
    sessions,
    workedById: worked,
    apptById: new Map([['appt_bcba', appointmentFor('BCBA')], ['appt_rbt', appointmentFor('RBT')]]),
    staffById: new Map([[BCBA, { firstName: 'Ben', lastName: 'Carter' }], [RBT, { firstName: 'Ann', lastName: 'Lee' }]]),
    clientById: new Map([[CLIENT, { firstName: 'Raymond', lastName: 'K' }]]),
    roleByStaffId: new Map([[BCBA, 'BCBA'], [RBT, 'RBT']]),
    rateByStaffId: new Map([
      [BCBA, { rateCents: 5000, rateType: 'HOURLY', currency: 'usd' }],
      [RBT, { rateCents: 2500, rateType: 'HOURLY', currency: 'usd' }],
    ]),
  });

  assert.equal(activities.length, 2, 'two independent clinicians, two activity rows — never merged');

  const payroll = aggregatePeriodPayroll({
    records: activities.map((a) => ({
      sessionId: a.sessionId, appointmentId: a.appointmentId, staffProfileId: a.staffProfileId,
      clientId: a.clientId, startedAt: a.sessionStart, endedAt: a.sessionEnd,
      workedMinutes: a.workedMinutes, intervals: a.intervals,
    })),
    apptById: new Map([['appt_bcba', appointmentFor('BCBA')], ['appt_rbt', appointmentFor('RBT')]]),
    staffById: new Map([[BCBA, { firstName: 'Ben', lastName: 'Carter' }], [RBT, { firstName: 'Ann', lastName: 'Lee' }]]),
    clientNameById: new Map([[CLIENT, 'Raymond K']]),
    // aggregatePeriodPayroll takes the effective hourly rate directly, in
    // integer cents — not a wrapper object.
    rateByStaff: new Map([[BCBA, 5000], [RBT, 2500]]),
    roleByStaffId: new Map([[BCBA, 'BCBA'], [RBT, 'RBT']]),
    window: { start: DAY_START, end: DAY_END },
  });

  const byName = Object.fromEntries((payroll.staff ?? []).map((s) => [s.staffName, s]));
  const bcbaRow = byName['Ben Carter'];
  const rbtRow = byName['Ann Lee'];
  assert.ok(bcbaRow && rbtRow, 'BOTH clinicians must appear in payroll');

  assert.equal(bcbaRow.role, 'BCBA');
  assert.equal(bcbaRow.sessionCount, 1, 'three work periods are still ONE session');
  assert.equal(bcbaRow.workedMinutes, 150);
  assert.equal(bcbaRow.hourlyRate, 5000);
  assert.equal(bcbaRow.amount, 12500);

  assert.equal(rbtRow.role, 'RBT');
  assert.equal(rbtRow.sessionCount, 1);
  assert.equal(rbtRow.workedMinutes, 150);
  assert.equal(rbtRow.hourlyRate, 2500);
  assert.equal(rbtRow.amount, 6250);

  assert.equal(payroll.summary.totalAmount, 18750, 'company total $187.50');
  assert.equal(payroll.summary.totalMinutes, 300, '150 + 150');
  assert.equal(payroll.summary.sessionCount, 2, 'two sessions, not five work periods');
});

test('the two clinicians are never merged, despite the same client and day', async () => {
  // ONE harness holds both appointments, so both sessions live in the same
  // store exactly as they would in one database — ids, indexes and all.
  const shared = createHarness({
    timeZone: 'America/New_York',
    now: at(9).toISOString(),
    hourlyRatesByStaff: { [BCBA]: 50, [RBT]: 25 },
    appointment: appointmentFor('BCBA'),
  });
  const bcba = await workDay({ role: 'BCBA', staffProfileId: BCBA, rateDollars: 50, periods: BCBA_PERIODS, harness: shared });
  const rbt = await workDay({ role: 'RBT', staffProfileId: RBT, rateDollars: 25, periods: RBT_PERIODS, harness: shared });

  const all = shared.allSessions(TENANT);
  assert.equal(all.length, 2, 'two independent sessions in one store');
  const b = all.find((x) => x.staffProfileId === BCBA);
  const r = all.find((x) => x.staffProfileId === RBT);

  assert.notEqual(b.id, r.id);
  assert.notEqual(b.appointmentId, r.appointmentId, 'one clinician per appointment');
  assert.notEqual(b.staffProfileId, r.staffProfileId);
  assert.equal(b.clientId, r.clientId, 'same client, deliberately');

  // Identical worked totals reached by DIFFERENT period shapes — proof the
  // totals are summed per clinician rather than derived from a shared window.
  assert.equal(bcba.completion.timeRecord.workedMinutes, 150);
  assert.equal(rbt.completion.timeRecord.workedMinutes, 150);
  assert.equal(b.intervals.filter((i) => i.endedAt).length, 3);
  assert.equal(r.intervals.filter((i) => i.endedAt).length, 2);

  // Different rates, so identical time must NOT produce identical pay.
  assert.equal(bcba.completion.timeRecord.amount, 12500);
  assert.equal(rbt.completion.timeRecord.amount, 6250);
});
