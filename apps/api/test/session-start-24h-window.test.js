import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBookingInput } from '../src/modules/scheduling/booking.js';
import { startEligibility, zonedWallTimeToUtc, START_WINDOW_MS } from '../src/domain/businessDate.js';
import { SessionsService } from '../src/modules/sessions/sessions.service.js';
import { createHarness } from './helpers/sessionHarness.js';

/**
 * ---------------------------------------------------------------------------
 * SESSION START WINDOW — a strict 24-hour, TIMESTAMP-based rule.
 *
 * The start window opens at the appointment's scheduled start (org-timezone
 * midnight for a date-only booking) and closes exactly 24 hours later. It is
 * NOT "appointment date === today": a 09/12 10:00 AM appointment is still
 * startable at 09/13 09:00 AM and expires at 09/13 10:00 AM.
 *
 * Runs the real booking core, the real startEligibility rule and the REAL
 * BcbaSessionService / SessionsService over the in-memory harness. The clock is
 * pinned per test — today is never hardcoded. No live MongoDB here.
 * ---------------------------------------------------------------------------
 */

const TZ = 'America/New_York';
const TENANT = 'org1';
const BCBA = 'staff1';
const RBT = 'rbt1';

/** Real org-timezone wall clock → instant ("09/13/2026 10:01 AM ET"). */
const wall = (date, hh, mm = 0, ss = 0, tz = TZ) => {
  const [y, m, d] = date.split('-').map(Number);
  return zonedWallTimeToUtc(y, m, d, hh, mm, ss, tz);
};
/** Book through the real booking core: timed when a start time is given, else date-only. */
const book = (date, time = null, tz = TZ, endDate = date) => normalizeBookingInput({
  clientId: 'child1', bcbaId: BCBA, authorizationIds: ['auth1'], units: 4, startDate: date, endDate,
  ...(time ? { startTime: time, endTime: `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:${time.slice(3)}` } : {}),
}, { timeZone: tz });
const doc = (booked, id = 'appt_1', extra = {}) => ({
  id, tenantId: TENANT, clientId: 'child1', bcbaId: BCBA, rbtId: null, staffProfileId: BCBA,
  startAt: booked.startAt, endAt: booked.endAt, timeSet: booked.timeSet,
  authorizationId: 'auth1', authorizationIds: ['auth1'], units: 4, status: 'SCHEDULED', ...extra,
});
const statusAt = (booked, instant, tz = TZ) => startEligibility(booked, tz, instant).status;

async function tryStart({ booked, now, role = 'BCBA', tz = TZ }) {
  const staff = role === 'RBT' ? RBT : BCBA;
  const appt = doc(booked, 'appt_1', role === 'RBT' ? { bcbaId: null, rbtId: RBT, staffProfileId: RBT } : {});
  const h = createHarness({ timeZone: tz, now: new Date(now).toISOString(), appointment: appt });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: staff, appointmentId: 'appt_1', ...(role === 'RBT' ? { role: 'RBT' } : {}) };
  try {
    const s = await h.service.startSession(call);
    return { ok: true, session: s, h };
  } catch (e) {
    return { ok: false, error: e, h };
  }
}

// ---- the rule itself --------------------------------------------------------

test('the window is exactly 24 hours of elapsed time, opening at the scheduled start', () => {
  const b = book('2026-09-12', '10:00');
  const e = startEligibility(b, TZ, wall('2026-09-12', 12));
  assert.equal(e.status, 'AVAILABLE');
  assert.equal(e.windowStart.toISOString(), b.startAt.toISOString());
  assert.equal(e.windowEnd.getTime() - e.windowStart.getTime(), START_WINDOW_MS);
  assert.equal(e.windowEnd.toISOString(), wall('2026-09-13', 10).toISOString());
});

test('1. 09/12 10:00 AM appointment → 09/13 9:00 AM = ALLOWED (server start succeeds)', async () => {
  const b = book('2026-09-12', '10:00');
  assert.equal(statusAt(b, wall('2026-09-13', 9)), 'AVAILABLE');
  const r = await tryStart({ booked: b, now: wall('2026-09-13', 9) });
  assert.equal(r.ok, true);
  assert.equal(r.session.status, 'IN_PROGRESS');
});

test('2. 09/12 10:00 AM appointment → 09/13 10:00 AM = EXPIRED (exact boundary is exclusive)', async () => {
  const b = book('2026-09-12', '10:00');
  assert.equal(statusAt(b, wall('2026-09-13', 9, 59, 59)), 'AVAILABLE'); // 09:59:59 still open
  assert.equal(statusAt(b, wall('2026-09-13', 10)), 'EXPIRED');
  const r = await tryStart({ booked: b, now: wall('2026-09-13', 10) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'APPOINTMENT_NOT_TODAY');
});

test('3. 09/12 10:00 AM appointment → 09/13 10:01 AM = EXPIRED', async () => {
  const b = book('2026-09-12', '10:00');
  assert.equal(statusAt(b, wall('2026-09-13', 10, 1)), 'EXPIRED');
  const r = await tryStart({ booked: b, now: wall('2026-09-13', 10, 1) });
  assert.equal(r.ok, false);
  assert.equal(r.error.details.startStatus, 'EXPIRED');
  assert.match(r.error.message, /closed at 09\/13\/2026 10:00 AM/);
});

test('4. 09/12 7:00 PM appointment → 09/13 6:30 PM = ALLOWED', async () => {
  const b = book('2026-09-12', '19:00');
  assert.equal(statusAt(b, wall('2026-09-13', 18, 30)), 'AVAILABLE');
  const r = await tryStart({ booked: b, now: wall('2026-09-13', 18, 30) });
  assert.equal(r.ok, true);
});

test('5. 09/12 7:00 PM appointment → 09/13 7:01 PM = EXPIRED', async () => {
  const b = book('2026-09-12', '19:00');
  assert.equal(statusAt(b, wall('2026-09-13', 19, 1)), 'EXPIRED');
  const r = await tryStart({ booked: b, now: wall('2026-09-13', 19, 1) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'APPOINTMENT_NOT_TODAY');
});

test('it is not a calendar-date comparison: a 7 PM appointment is still open on the NEXT calendar date', () => {
  const b = book('2026-09-12', '19:00');
  for (const [h, m] of [[0, 0], [8, 0], [12, 0], [18, 59]]) {
    assert.equal(statusAt(b, wall('2026-09-13', h, m)), 'AVAILABLE', `09/13 ${h}:${m}`);
  }
});

test('6. a future appointment is not startable before its window opens (UPCOMING) — then opens on time', async () => {
  const b = book('2026-09-14', '10:00');
  const early = await tryStart({ booked: b, now: wall('2026-09-14', 9, 59) });
  assert.equal(early.ok, false);
  assert.equal(early.error.details.startStatus, 'UPCOMING');
  assert.match(early.error.message, /from 09\/14\/2026 10:00 AM/);
  const onTime = await tryStart({ booked: b, now: wall('2026-09-14', 10) });
  assert.equal(onTime.ok, true);
});

test('7. panel cards: expired is flagged not-startable; only the currently-open window is startable; next opens on its own', async () => {
  const d12 = book('2026-09-12', '10:00');
  const d13 = book('2026-09-13', '10:00');
  const d14 = book('2026-09-14', '10:00');
  const h = createHarness({ timeZone: TZ, now: wall('2026-09-13', 11).toISOString() });
  h.addAppointment(doc(d12, 'a12'));
  h.addAppointment(doc(d13, 'a13'));
  h.addAppointment(doc(d14, 'a14'));
  const cards = async () => Object.fromEntries((await h.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: BCBA }))
    .map((c) => [c.appointmentId, c]));

  let c = await cards();                                   // 09/13 11:00 AM
  assert.deepEqual([c.a12.startStatus, c.a13.startStatus, c.a14.startStatus], ['EXPIRED', 'AVAILABLE', 'UPCOMING']);
  assert.equal(c.a12.startableNow, false);
  assert.equal(c.a12.expired, true);
  assert.equal(c.a13.startableNow, true);
  assert.equal(new Date(c.a13.startWindowEnd).toISOString(), wall('2026-09-14', 10).toISOString());

  h.clock.set(wall('2026-09-13', 9, 30).toISOString()); // both 09/12 (still open) and 09/13 (not yet) — no arbitrary pick
  c = await cards();
  assert.deepEqual([c.a12.startStatus, c.a13.startStatus, c.a14.startStatus], ['AVAILABLE', 'UPCOMING', 'UPCOMING']);

  h.clock.set(wall('2026-09-14', 10).toISOString());     // 09/13 closes exactly as 09/14 opens
  c = await cards();
  assert.deepEqual([c.a12.startStatus, c.a13.startStatus, c.a14.startStatus], ['EXPIRED', 'EXPIRED', 'AVAILABLE']);
});

test('8. backend rejects a direct (manipulated) start of an expired appointment on every start path', async () => {
  const b = book('2026-09-12', '10:00');
  const now = wall('2026-09-13', 10, 1);

  // Brand-new session.
  const fresh = await tryStart({ booked: b, now });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.error.status, 409);
  assert.equal(fresh.h.allSessions(TENANT).length, 0);

  // Resume of a session stopped inside the window.
  const h = createHarness({ timeZone: TZ, now: wall('2026-09-12', 10, 30).toISOString(), appointment: doc(b) });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };
  await h.service.startSession(call);
  h.clock.advanceMinutes(30);
  await h.service.stopSession(call);
  h.clock.set(now.toISOString());
  await assert.rejects(() => h.service.startSession(call), (e) => e.code === 'APPOINTMENT_NOT_TODAY');
  const done = await h.service.completeSession({ ...call, authorizationId: 'auth1' });
  assert.equal(done.timeRecord.workedMinutes, 30, 'finishing recorded work is still allowed');

  // Lifecycle clock-in — the client-supplied `at` is ignored; the server clock decides.
  const svc = new SessionsService({
    now: () => now,
    repository: {
      findSessionById: async () => ({ id: 's1', appointmentId: 'appt_1', clientId: 'child1', staffProfileId: BCBA, status: 'DRAFT' }),
      updateSession: async () => { throw new Error('must not write'); },
    },
    organizations: { getById: async () => ({ state: 'ACTIVE', timezone: TZ }) },
    appointments: { findById: async () => doc(b) },
    plans: {},
    phi: { seal: (v) => v, open: (v) => v },
  });
  await assert.rejects(
    () => svc.clockIn({ tenantId: TENANT, sessionId: 's1', actorUserId: 'u1', actorStaffProfileId: BCBA, at: wall('2026-09-12', 11).toISOString() }),
    (e) => e.code === 'APPOINTMENT_NOT_TODAY' && e.details.startStatus === 'EXPIRED',
  );
});

test('9. BCBA: same 24-hour behaviour', async () => {
  const b = book('2026-09-12', '10:00');
  assert.equal((await tryStart({ booked: b, now: wall('2026-09-13', 9, 59), role: 'BCBA' })).ok, true);
  assert.equal((await tryStart({ booked: b, now: wall('2026-09-13', 10, 1), role: 'BCBA' })).ok, false);
});

test('10. RBT: same 24-hour behaviour', async () => {
  const b = book('2026-09-12', '19:00');
  assert.equal((await tryStart({ booked: b, now: wall('2026-09-13', 18, 30), role: 'RBT' })).ok, true);
  const late = await tryStart({ booked: b, now: wall('2026-09-13', 19, 1), role: 'RBT' });
  assert.equal(late.ok, false);
  assert.equal(late.error.details.startStatus, 'EXPIRED');
});

test('11a. business timezone: the same local appointment/time behaves identically in every org zone', () => {
  for (const tz of ['America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Europe/London', 'UTC']) {
    const b = book('2026-09-12', '19:00', tz);
    assert.equal(statusAt(b, wall('2026-09-13', 18, 30, 0, tz), tz), 'AVAILABLE', tz);
    assert.equal(statusAt(b, wall('2026-09-13', 19, 1, 0, tz), tz), 'EXPIRED', tz);
  }
});

test('11b. DST fall-back (US, 11/01/2026): the window is 24 REAL hours, so it closes at 6:00 PM EST', () => {
  const b = book('2026-10-31', '19:00');                          // 7:00 PM EDT
  const e = startEligibility(b, TZ, wall('2026-11-01', 12));
  assert.equal(e.windowEnd.getTime() - e.windowStart.getTime(), START_WINDOW_MS);
  assert.equal(statusAt(b, wall('2026-11-01', 17, 59)), 'AVAILABLE');
  assert.equal(statusAt(b, wall('2026-11-01', 18, 0)), 'EXPIRED'); // 24h after 7 PM EDT
});

test('11c. DST spring-forward (US, 03/08/2026): 24 real hours → closes at 8:00 PM EDT', () => {
  const b = book('2026-03-07', '19:00');                          // 7:00 PM EST
  assert.equal(statusAt(b, wall('2026-03-08', 19, 59)), 'AVAILABLE');
  assert.equal(statusAt(b, wall('2026-03-08', 20, 0)), 'EXPIRED');
});

test('12. date-only (timeSet:false): window opens at org midnight of the business date, exactly 24h', async () => {
  const b = book('2026-09-12');
  assert.equal(b.timeSet, false);
  const e = startEligibility(b, TZ, wall('2026-09-12', 8));
  assert.equal(e.windowStart.toISOString(), wall('2026-09-12', 0).toISOString());
  assert.equal(statusAt(b, wall('2026-09-11', 23, 59, 59)), 'UPCOMING');
  assert.equal(statusAt(b, wall('2026-09-12', 0)), 'AVAILABLE');
  assert.equal(statusAt(b, wall('2026-09-12', 23, 59, 59)), 'AVAILABLE');
  assert.equal(statusAt(b, wall('2026-09-13', 0)), 'EXPIRED');
  assert.equal((await tryStart({ booked: b, now: wall('2026-09-12', 23, 30) })).ok, true);
  assert.equal((await tryStart({ booked: b, now: wall('2026-09-13', 0, 1) })).ok, false);
});

test('12b. date-only multi-day (09/12 → 09/14): one 24h window per scheduled date; expires when the last closes', () => {
  const b = book('2026-09-12', null, TZ, '2026-09-14');
  assert.equal(statusAt(b, wall('2026-09-13', 12)), 'AVAILABLE');
  const onLast = startEligibility(b, TZ, wall('2026-09-14', 23));
  assert.equal(onLast.status, 'AVAILABLE');
  assert.equal(onLast.businessDate, '2026-09-14');
  assert.equal(statusAt(b, wall('2026-09-15', 0)), 'EXPIRED');
});

test('12c. date-only on the DST fall-back date keeps the strict 24h length (closes 11:00 PM EST that night)', () => {
  const b = book('2026-11-01');
  assert.equal(statusAt(b, wall('2026-11-01', 22, 59)), 'AVAILABLE');
  assert.equal(statusAt(b, wall('2026-11-01', 23, 0)), 'EXPIRED');
});

test('an undated appointment is not window-gated; a running session is never cut off', async () => {
  assert.equal(startEligibility({ startAt: null }, TZ).status, 'AVAILABLE');
  const b = book('2026-09-12', '10:00');
  const h = createHarness({ timeZone: TZ, now: wall('2026-09-13', 9, 50).toISOString(), appointment: doc(b) });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };
  const started = await h.service.startSession(call);
  h.clock.advanceMinutes(30);                                   // 10:20 AM — window closed
  assert.equal((await h.service.startSession(call)).id, started.id, 'running session returned, not refused');
  const stopped = await h.service.stopSession(call);
  assert.equal(stopped.workedMinutes, 30);
});
