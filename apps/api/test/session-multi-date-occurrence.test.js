import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBookingInput } from '../src/modules/scheduling/booking.js';
import { startEligibility, sessionBusinessDate, zonedWallTimeToUtc } from '../src/domain/businessDate.js';
import { createHarness } from './helpers/sessionHarness.js';

/**
 * ---------------------------------------------------------------------------
 * MULTI-DATE APPOINTMENTS — each scheduled business date is its OWN occurrence.
 *
 * Booking 09/12/2026 → 09/30/2026 (date-only, org timezone America/New_York).
 * On 09/13/2026 the 09/12 occurrence is expired, 09/13 is eligible and 09/14+
 * are future. Work begun on 09/12 is bound to 09/12 and can never be resumed
 * under 09/13's window. The real booking core, the shared startEligibility rule
 * and the REAL BcbaSessionService run over the in-memory harness; the clock is
 * pinned per test (no live MongoDB here).
 * ---------------------------------------------------------------------------
 */

const TZ = 'America/New_York';
const TENANT = 'org1';
const BCBA = 'staff1';
const RBT = 'rbt1';
const wall = (date, hh, mm = 0) => { const [y, m, d] = date.split('-').map(Number); return zonedWallTimeToUtc(y, m, d, hh, mm, 0, TZ); };
const RANGE = normalizeBookingInput(
  { clientId: 'child1', bcbaId: BCBA, authorizationIds: ['auth1'], units: 4, startDate: '2026-09-12', endDate: '2026-09-30' },
  { timeZone: TZ },
);
const doc = (role = 'BCBA') => ({
  id: 'appt_1', tenantId: TENANT, clientId: 'child1', startAt: RANGE.startAt, endAt: RANGE.endAt, timeSet: RANGE.timeSet,
  authorizationId: 'auth1', authorizationIds: ['auth1'], units: 4, status: 'SCHEDULED',
  ...(role === 'RBT' ? { bcbaId: null, rbtId: RBT, staffProfileId: RBT } : { bcbaId: BCBA, rbtId: null, staffProfileId: BCBA }),
});
const callFor = (role = 'BCBA') => ({
  tenantId: TENANT, actorUserId: 'u1', appointmentId: 'appt_1',
  bcbaStaffProfileId: role === 'RBT' ? RBT : BCBA, ...(role === 'RBT' ? { role: 'RBT' } : {}),
});
const occ = (date, now) => startEligibility(RANGE, TZ, now, { businessDate: date }).status;

test('the booking really is one date-only appointment spanning 09/12 → 09/30', () => {
  assert.equal(RANGE.timeSet, false);
  assert.equal(RANGE.startAt.toISOString(), wall('2026-09-12', 0).toISOString());
  assert.equal(RANGE.endAt.toISOString(), wall('2026-10-01', 0).toISOString());
});

test('on 09/13: 09/12 occurrence EXPIRED, 09/13 ELIGIBLE, 09/14 FUTURE — each judged by its own date', () => {
  const now = wall('2026-09-13', 10);
  assert.equal(occ('2026-09-12', now), 'EXPIRED');
  assert.equal(occ('2026-09-13', now), 'AVAILABLE');
  assert.equal(occ('2026-09-14', now), 'UPCOMING');
  assert.equal(occ('2026-09-30', now), 'UPCOMING');

  // The appointment-level answer is the OPEN occurrence — 09/13, not 09/12 and
  // not the range end.
  const current = startEligibility(RANGE, TZ, now);
  assert.equal(current.status, 'AVAILABLE');
  assert.equal(current.businessDate, '2026-09-13');
  assert.equal(current.windowStart.toISOString(), wall('2026-09-13', 0).toISOString());
  assert.equal(current.windowEnd.toISOString(), wall('2026-09-14', 0).toISOString());
});

test('09/30 becomes eligible only when its own date arrives, and the booking expires after it', () => {
  assert.equal(occ('2026-09-30', wall('2026-09-29', 23, 59)), 'UPCOMING');
  assert.equal(occ('2026-09-30', wall('2026-09-30', 0)), 'AVAILABLE');
  const on29 = startEligibility(RANGE, TZ, wall('2026-09-29', 12));
  assert.equal(on29.businessDate, '2026-09-29');
  const on30 = startEligibility(RANGE, TZ, wall('2026-09-30', 12));
  assert.equal(on30.businessDate, '2026-09-30');
  assert.equal(startEligibility(RANGE, TZ, wall('2026-10-01', 0)).status, 'EXPIRED');
});

for (const role of ['BCBA', 'RBT']) {
  test(`${role}: on 09/13 a new session starts for the 09/13 occurrence`, async () => {
    const h = createHarness({ timeZone: TZ, now: wall('2026-09-13', 9).toISOString(), appointment: doc(role) });
    const s = await h.service.startSession(callFor(role));
    assert.equal(s.status, 'IN_PROGRESS');
    const [card] = await h.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: callFor(role).bcbaStaffProfileId, role });
    assert.equal(card.sessionBusinessDate, '2026-09-13');
    assert.equal(card.startBusinessDate, '2026-09-13');
  });

  test(`${role}: a session begun on 09/12 can NOT be resumed on 09/13 (backend rejects the direct call)`, async () => {
    const h = createHarness({ timeZone: TZ, now: wall('2026-09-12', 15).toISOString(), appointment: doc(role) });
    const call = callFor(role);
    await h.service.startSession(call);
    h.clock.advanceMinutes(45);
    await h.service.stopSession(call);                 // stopped on 09/12, not finished

    h.clock.set(wall('2026-09-13', 10).toISOString());
    // Panel: the card represents the 09/12 occurrence and is EXPIRED — not 09/13's window.
    const [card] = await h.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: call.bcbaStaffProfileId, role });
    assert.equal(card.sessionStatus, 'STOPPED');
    assert.equal(card.sessionBusinessDate, '2026-09-12');
    assert.equal(card.startBusinessDate, '2026-09-12');
    assert.equal(card.startStatus, 'EXPIRED');
    assert.equal(card.startableNow, false);
    assert.equal(new Date(card.startWindowEnd).toISOString(), wall('2026-09-13', 0).toISOString());

    // Direct start/resume attempt (UI bypass) is refused by the server.
    await assert.rejects(() => h.service.startSession(call), (e) => {
      assert.equal(e.code, 'APPOINTMENT_NOT_TODAY');
      assert.equal(e.status, 409);
      assert.equal(e.details.startStatus, 'EXPIRED');
      assert.equal(e.details.businessDate, '2026-09-12');
      assert.match(e.message, /belongs to 09\/12\/2026/);
      assert.doesNotMatch(e.message, /09\/13\/2026 11:59 PM/);
      return true;
    });

    // The 09/12 work can still be finished; then the 09/13 occurrence starts fresh.
    const done = await h.service.completeSession({ ...call, authorizationId: 'auth1' });
    assert.equal(done.timeRecord.workedMinutes, 45);
    const [after] = await h.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: call.bcbaStaffProfileId, role });
    assert.equal(after.sessionStatus, 'SCHEDULED');
    assert.equal(after.startBusinessDate, '2026-09-13');
    assert.equal(after.startStatus, 'AVAILABLE');
    const fresh = await h.service.startSession(call);
    assert.equal(fresh.status, 'IN_PROGRESS');
    assert.equal(h.allSessions(TENANT).length, 2, '09/12 and 09/13 are separate sessions');
  });

  test(`${role}: on 09/13 a session can't be started for 09/14 yet — only the open occurrence exists`, async () => {
    const h = createHarness({ timeZone: TZ, now: wall('2026-09-13', 23, 59).toISOString(), appointment: doc(role) });
    const [card] = await h.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: callFor(role).bcbaStaffProfileId, role });
    assert.equal(card.startBusinessDate, '2026-09-13');
    h.clock.set(wall('2026-09-14', 0).toISOString());
    const [next] = await h.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: callFor(role).bcbaStaffProfileId, role });
    assert.equal(next.startBusinessDate, '2026-09-14');
    assert.equal(next.startStatus, 'AVAILABLE');
  });
}

test('a session running across midnight stays bound to its own date and can still be stopped', async () => {
  const h = createHarness({ timeZone: TZ, now: wall('2026-09-12', 23, 30).toISOString(), appointment: doc() });
  const call = callFor();
  const started = await h.service.startSession(call);
  h.clock.set(wall('2026-09-13', 0, 30).toISOString());
  const again = await h.service.startSession(call);         // running → returned untouched
  assert.equal(again.id, started.id);
  const [card] = await h.service.listPanel({ tenantId: TENANT, bcbaStaffProfileId: BCBA });
  assert.equal(card.sessionBusinessDate, '2026-09-12');
  const stopped = await h.service.stopSession(call);
  assert.equal(stopped.workedMinutes, 60);
});

test('sessionBusinessDate: a never-started DRAFT is unbound; started work binds to the window it began in', () => {
  const appt = doc();
  assert.equal(sessionBusinessDate(appt, { status: 'DRAFT', startedAt: RANGE.startAt, intervals: [] }, TZ), null);
  assert.equal(sessionBusinessDate(appt, { status: 'IN_PROGRESS', intervals: [{ startedAt: wall('2026-09-15', 11) }] }, TZ), '2026-09-15');
  assert.equal(sessionBusinessDate(appt, { status: 'IN_PROGRESS', clockInAt: wall('2026-09-20', 8), intervals: [] }, TZ), '2026-09-20');
});
