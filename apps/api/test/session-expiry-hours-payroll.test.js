import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBookingInput } from '../src/modules/scheduling/booking.js';
import { startEligibility, lastBusinessDateString } from '../src/domain/businessDate.js';
import { companyPeriodWindow, HOURS_WEEK_STARTS_ON } from '../src/modules/bcba-session/weeklyHours.js';
import { resolvePayrollWindow, biweeklyPayPeriodWindow, aggregatePeriodPayroll } from '../src/modules/payroll/payroll.periods.js';
import { SessionsService } from '../src/modules/sessions/sessions.service.js';
import { createHarness } from './helpers/sessionHarness.js';

/**
 * ---------------------------------------------------------------------------
 * HIGH PRIORITY regressions:
 *   1. an appointment whose business date has passed can't be started (server)
 *   2. My Hours is a strict Monday → Sunday week in the org timezone
 *   3. bi-weekly payroll periods roll over without overlapping
 *
 * "Today" is never hardcoded: every test pins its own clock. Runs the REAL
 * services over the in-memory harness (no live MongoDB in this environment).
 * ---------------------------------------------------------------------------
 */

const TZ = 'America/New_York';
const TENANT = 'org1';
const BCBA = 'staff1';
const RBT = 'rbt1';
const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };

const book = (startDate, endDate = startDate, tz = TZ) => normalizeBookingInput(
  { clientId: 'child1', bcbaId: BCBA, authorizationIds: ['auth1'], units: 8, startDate, endDate }, { timeZone: tz },
);
const apptDoc = (booked, extra = {}) => ({
  id: 'appt_1', tenantId: TENANT, clientId: 'child1', bcbaId: BCBA, rbtId: null, staffProfileId: BCBA,
  startAt: booked.startAt, endAt: booked.endAt, timeSet: booked.timeSet, authorizationId: 'auth1',
  authorizationIds: ['auth1'], units: 8, status: 'SCHEDULED', ...extra,
});
/** An org-local wall clock on a business date, e.g. at('2026-09-13', 0, 0). */
const at = (booked, dayOffset, hours, minutes = 0) =>
  new Date(booked.startAt.getTime() + dayOffset * 86400000 + (hours * 60 + minutes) * 60000).toISOString();

// ============================ 1. SESSION DATE EXPIRY ========================

test('date-only expired appointment is identified: 24h window from org midnight 09/12 closes at 00:00 09/13 (org tz)', () => {
  for (const tz of ['America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
    const b = book('2026-09-12', '2026-09-12', tz);
    const s = (d, h, m) => startEligibility(b, tz, new Date(at(b, d, h, m))).status;
    assert.equal(s(-1, 23, 59), 'UPCOMING', tz);
    assert.equal(s(0, 0, 0), 'AVAILABLE', tz);
    assert.equal(s(0, 23, 59), 'AVAILABLE', tz);
    assert.equal(s(1, 0, 0), 'EXPIRED', tz);
    assert.equal(lastBusinessDateString(b.startAt, b.endAt, tz), '2026-09-12');
  }
});

test("yesterday's appointment cannot START today — server refuses (APPOINTMENT_NOT_TODAY, EXPIRED)", async () => {
  const b = book('2026-09-12');
  const h = createHarness({ timeZone: TZ, now: at(b, 1, 9), appointment: apptDoc(b) }); // 09/13 09:00 ET
  await assert.rejects(() => h.service.startSession(call), (e) => {
    assert.equal(e.code, 'APPOINTMENT_NOT_TODAY');
    assert.equal(e.status, 409);
    assert.equal(e.details.startStatus, 'EXPIRED');
    assert.equal(e.details.businessDate, '2026-09-12');
    assert.match(e.message, /expired/i);
    assert.match(e.message, /09\/13\/2026 12:00 AM/); // date-only window: org midnight 09/12 + 24h
    return true;
  });
  assert.equal(h.allSessions(TENANT).length, 0, 'no session row was created');
});

test("today's appointment can start (same-day behaviour unchanged)", async () => {
  const b = book('2026-09-13');
  const h = createHarness({ timeZone: TZ, now: at(b, 0, 9), appointment: apptDoc(b) });
  const s = await h.service.startSession(call);
  assert.equal(s.status, 'IN_PROGRESS');
});

test('an RBT is refused the same way for an expired appointment', async () => {
  const b = book('2026-09-12');
  const h = createHarness({ timeZone: TZ, now: at(b, 1, 9), appointment: apptDoc(b, { bcbaId: null, rbtId: RBT, staffProfileId: RBT }) });
  await assert.rejects(
    () => h.service.startSession({ ...call, bcbaStaffProfileId: RBT, role: 'RBT' }),
    (e) => e.code === 'APPOINTMENT_NOT_TODAY' && e.details.startStatus === 'EXPIRED',
  );
});

test('a STOPPED session cannot be RESUMED once its appointment has expired — but it can still be finished', async () => {
  const b = book('2026-09-12');
  const h = createHarness({ timeZone: TZ, now: at(b, 0, 15), appointment: apptDoc(b) });
  await h.service.startSession(call);
  h.clock.advanceMinutes(60);
  await h.service.stopSession(call);               // stopped on 09/12, not completed
  h.clock.set(at(b, 1, 9));                         // 09/13 09:00 ET
  await assert.rejects(() => h.service.startSession(call), (e) => e.code === 'APPOINTMENT_NOT_TODAY');
  const done = await h.service.completeSession({ ...call, authorizationId: 'auth1' });
  assert.equal(done.timeRecord.workedMinutes, 60, 'recorded work is never lost');
});

test('a pre-existing DRAFT session cannot be used to start an expired appointment', async () => {
  const b = book('2026-09-12');
  const h = createHarness({ timeZone: TZ, now: at(b, 1, 9), appointment: apptDoc(b) });
  await h.service.deps.sessions.create(TENANT, { appointmentId: 'appt_1', clientId: 'child1', staffProfileId: BCBA, status: 'DRAFT' });
  await assert.rejects(() => h.service.startSession(call), (e) => e.code === 'APPOINTMENT_NOT_TODAY');
});

test('a session RUNNING across midnight is returned untouched (no new start) and can be stopped', async () => {
  const b = book('2026-09-12');
  const h = createHarness({ timeZone: TZ, now: at(b, 0, 23), appointment: apptDoc(b) });
  const started = await h.service.startSession(call);
  h.clock.advanceMinutes(90);                        // 00:30 on 09/13
  const again = await h.service.startSession(call);
  assert.equal(again.id, started.id);
  const stopped = await h.service.stopSession(call);
  assert.equal(stopped.workedMinutes, 90);
});

test('panel cards expose the start-window status the UI shows (expired / startableNow)', async () => {
  const b = book('2026-09-12');
  const h = createHarness({ timeZone: TZ, now: at(b, 1, 9), appointment: apptDoc(b) });
  const [card] = await h.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: BCBA });
  assert.equal(card.startStatus, 'EXPIRED');
  assert.equal(card.expired, true);
  assert.equal(card.startableNow, false);
  assert.equal(card.lastBusinessDate, '2026-09-12');

  const today = book('2026-09-13');
  const h2 = createHarness({ timeZone: TZ, now: at(today, 0, 9), appointment: apptDoc(today) });
  const [live] = await h2.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: BCBA });
  assert.equal(live.startStatus, 'AVAILABLE');
  assert.equal(live.startableNow, true);
  assert.equal(live.canStart, true);
});

test('lifecycle clock-in is gated too: expired refused, today allowed (server clock, not client `at`)', async () => {
  const b = book('2026-09-12');
  const make = (nowIso) => {
    const updates = [];
    const svc = new SessionsService({
      now: () => new Date(nowIso),
      repository: {
        findSessionById: async () => ({ id: 's1', appointmentId: 'appt_1', clientId: 'child1', staffProfileId: BCBA, status: 'DRAFT' }),
        updateSession: async (_t, id, patch) => { updates.push(patch); return { id, ...patch }; },
      },
      organizations: { getById: async () => ({ state: 'ACTIVE', timezone: TZ }) },
      appointments: { findById: async () => apptDoc(b) },
      plans: {},
      phi: { seal: (v) => v, open: (v) => v },
    });
    return { svc, updates };
  };
  const expired = make(at(b, 1, 9));
  await assert.rejects(
    () => expired.svc.clockIn({ tenantId: TENANT, sessionId: 's1', actorUserId: 'u1', actorStaffProfileId: BCBA, at: at(b, 0, 9) }),
    (e) => e.code === 'APPOINTMENT_NOT_TODAY' && e.status === 409 && e.details.startStatus === 'EXPIRED',
  );
  assert.equal(expired.updates.length, 0);
  const ok = make(at(b, 0, 9));
  const r = await ok.svc.clockIn({ tenantId: TENANT, sessionId: 's1', actorUserId: 'u1', actorStaffProfileId: BCBA });
  assert.equal(r.status, 'IN_PROGRESS');
});

// ============================ 2. MY HOURS — MONDAY → SUNDAY ================

test('My Hours week is strictly Monday → Sunday in the org timezone', () => {
  assert.equal(HOURS_WEEK_STARTS_ON, 1);
  // Sunday 09/13/2026 23:59 ET → current week Mon 09/07 00:00 ET … Mon 09/14 00:00 ET (exclusive).
  const sun = companyPeriodWindow(new Date('2026-09-14T03:59:00Z'), TZ, HOURS_WEEK_STARTS_ON, 'week');
  assert.equal(sun.start.toISOString(), '2026-09-07T04:00:00.000Z');
  assert.equal(sun.end.toISOString(), '2026-09-14T04:00:00.000Z');
  // Monday 09/14/2026 00:00 ET → a new week.
  const mon = companyPeriodWindow(new Date('2026-09-14T04:00:00Z'), TZ, HOURS_WEEK_STARTS_ON, 'week');
  assert.equal(mon.start.toISOString(), '2026-09-14T04:00:00.000Z');
  assert.equal(mon.end.toISOString(), '2026-09-21T04:00:00.000Z');
});

test('My Hours week is DST-correct (week containing the Nov 1 2026 fall-back)', () => {
  const w = companyPeriodWindow(new Date('2026-10-30T15:00:00Z'), TZ, HOURS_WEEK_STARTS_ON, 'week');
  assert.equal(w.start.toISOString(), '2026-10-26T04:00:00.000Z'); // Mon 00:00 EDT
  assert.equal(w.end.toISOString(), '2026-11-02T05:00:00.000Z');   // Mon 00:00 EST
});

/** Wire the harness's time-record store into the sum ports, filtering exactly like the repository (startedAt in [from, to)). */
function wireSums(h) {
  const inWindow = (r, { staffProfileId, from, to }) => r.staffProfileId === staffProfileId
    && new Date(r.startedAt) >= new Date(from) && new Date(r.startedAt) < new Date(to) && r.endedAt;
  h.service.deps.timeRecords.sumWorkedSeconds = async (tenantId, q) => {
    const rows = h.allTimeRecords(tenantId).filter((r) => inWindow(r, q));
    return { seconds: rows.reduce((t, r) => t + Math.round((new Date(r.endedAt) - new Date(r.startedAt)) / 1000), 0), sessions: rows.length };
  };
  h.service.deps.timeRecords.sumWorkedMinutes = async (tenantId, q) => {
    const rows = h.allTimeRecords(tenantId).filter((r) => inWindow(r, q));
    return { minutes: rows.reduce((t, r) => t + r.workedMinutes, 0), sessions: rows.length };
  };
}

test('Monday rollover: previous week drops out, new week starts at 0, new work counts — nothing deleted', async () => {
  const sunday = book('2026-09-13');
  const h = createHarness({ timeZone: TZ, now: at(sunday, 0, 10), appointment: apptDoc(sunday) });
  wireSums(h);
  await h.service.startSession(call);
  h.clock.advanceMinutes(120);
  await h.service.completeSession({ ...call, authorizationId: 'auth1' });

  const sundayView = await h.service.getMyHours({ tenantId: TENANT, bcbaStaffProfileId: BCBA });
  assert.equal(sundayView.hours, 2);
  assert.equal(sundayView.weekStartsOn, 1);

  // Monday 09/14 00:00 ET — the week rolls over.
  h.clock.set('2026-09-14T04:00:00Z');
  const mondayStart = await h.service.getMyHours({ tenantId: TENANT, bcbaStaffProfileId: BCBA });
  assert.equal(mondayStart.totalSeconds, 0);
  assert.equal(mondayStart.sessionCount, 0);
  assert.equal(h.allTimeRecords(TENANT).length, 1, 'historical record kept');

  // New work on Monday counts toward the new week automatically.
  const monday = book('2026-09-14');
  h.addAppointment(apptDoc(monday, { id: 'appt_2' }));
  h.clock.set(at(monday, 0, 9));
  await h.service.startSession({ ...call, appointmentId: 'appt_2' });
  h.clock.advanceMinutes(45);
  await h.service.completeSession({ ...call, appointmentId: 'appt_2', authorizationId: 'auth1' });
  const mondayView = await h.service.getMyHours({ tenantId: TENANT, bcbaStaffProfileId: BCBA });
  assert.equal(mondayView.minutes, 45);
  assert.equal(mondayView.sessionCount, 1);

  // The previous week's total is still there when asked for that week.
  const lastWeek = await h.service.getMyHours({ tenantId: TENANT, bcbaStaffProfileId: BCBA, now: '2026-09-13T20:00:00Z' });
  assert.equal(lastWeek.hours, 2);
});

test('the company weekStartsOn=Sunday setting no longer shifts My Hours (Sunday is the LAST day)', async () => {
  const b = book('2026-09-13');
  const h = createHarness({ timeZone: TZ, now: at(b, 0, 12), appointment: apptDoc(b) });
  h.service.deps.settings.getStaffing = async () => ({ weekStartsOn: 0 });
  const seen = [];
  h.service.deps.timeRecords.sumWorkedSeconds = async (_t, q) => { seen.push(q); return { seconds: 0, sessions: 0 }; };
  await h.service.getMyHours({ tenantId: TENANT, bcbaStaffProfileId: BCBA });
  assert.equal(seen[0].from.toISOString(), '2026-09-07T04:00:00.000Z');
  assert.equal(seen[0].to.toISOString(), '2026-09-14T04:00:00.000Z');
});

// ============================ 3. BI-WEEKLY PAYROLL =========================

test('bi-weekly payroll periods are contiguous and never overlap (26 periods)', () => {
  let cursor = biweeklyPayPeriodWindow(new Date('2026-09-09T15:00:00Z'), TZ, 1);
  for (let i = 0; i < 26; i += 1) {
    const next = biweeklyPayPeriodWindow(new Date(cursor.end.getTime() + 1000), TZ, 1);
    assert.equal(next.start.toISOString(), cursor.end.toISOString(), `period ${i} → ${i + 1} is contiguous`);
    // Every instant of a period resolves to that same period.
    const mid = biweeklyPayPeriodWindow(new Date(cursor.start.getTime() + 9 * 86400000), TZ, 1);
    assert.equal(mid.start.toISOString(), cursor.start.toISOString());
    cursor = next;
  }
});

test('bi-weekly rollover: last second of a period vs. the first second of the next (org tz)', () => {
  const last = resolvePayrollWindow({ mode: 'biweekly', anchor: '2026-09-21T03:59:59Z', timeZone: TZ, weekStartsOn: 1 }); // Sun 09/20 23:59:59 ET
  const first = resolvePayrollWindow({ mode: 'biweekly', anchor: '2026-09-21T04:00:00Z', timeZone: TZ, weekStartsOn: 1 }); // Mon 09/21 00:00 ET
  assert.equal(last.start.toISOString(), '2026-09-07T04:00:00.000Z');
  assert.equal(last.end.toISOString(), '2026-09-21T04:00:00.000Z');
  assert.equal(first.start.toISOString(), '2026-09-21T04:00:00.000Z');
  assert.equal(first.end.toISOString(), '2026-10-05T04:00:00.000Z');
  assert.equal(last.label, '09/07/2026 – 09/20/2026');
});

test('bi-weekly pay: persisted workedMinutes × effective rate, each record in exactly one period', () => {
  const records = [
    { sessionId: 's1', staffProfileId: 'b1', appointmentId: 'a1', startedAt: new Date('2026-09-20T18:00:00Z'), workedMinutes: 90 },  // Sun 09/20 ET → old period
    { sessionId: 's2', staffProfileId: 'b1', appointmentId: 'a1', startedAt: new Date('2026-09-21T13:00:00Z'), workedMinutes: 45 },  // Mon 09/21 ET → new period
  ];
  const payFor = (anchor) => {
    const w = resolvePayrollWindow({ mode: 'biweekly', anchor, timeZone: TZ, weekStartsOn: 1 });
    const inside = records.filter((r) => r.startedAt >= w.start && r.startedAt < w.end);
    return aggregatePeriodPayroll({ records: inside, rateByStaff: new Map([['b1', 6000]]), window: w }).summary;
  };
  const previous = payFor('2026-09-15T12:00:00Z');
  const current = payFor('2026-09-22T12:00:00Z');
  assert.equal(previous.totalMinutes, 90);
  assert.equal(previous.totalAmount, 9000);  // 1.5h × $60.00
  assert.equal(current.totalMinutes, 45);
  assert.equal(current.totalAmount, 4500);   // 0.75h × $60.00
  assert.equal(previous.sessionCount + current.sessionCount, records.length, 'no record counted twice');
});

// Appointment-note payload/RBAC coverage lives in appointment-notes-current-date.test.js.
