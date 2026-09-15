import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBookingInput } from '../src/modules/scheduling/booking.js';
import { validateTimeRange } from '../src/modules/scheduling/scheduling.rules.js';
import { coveredBusinessDates, coversBusinessDay } from '../src/domain/businessDate.js';
import { createHarness } from './helpers/sessionHarness.js';
import { reanchor } from '../scripts/migrate-appointment-business-dates.mjs';

/**
 * ---------------------------------------------------------------------------
 * BUSINESS DATE BEHAVIOUR (onboarding §6, §7, §8, §19, §20, §29).
 *
 * The reported bug: an appointment created for September 12 could show on
 * September 13 in the calendar, and the assigned clinician could be told "Not
 * available for today" on September 12.
 *
 * These tests run the REAL booking core and the REAL start gate (through the
 * actual BcbaSessionService) across several organization timezones, because the
 * defect was invisible in UTC and only appeared once the business zone differed
 * from it. A test that only ran in UTC would have passed against the broken
 * code.
 * ---------------------------------------------------------------------------
 */

const ZONES = ['America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Europe/London', 'UTC'];
const BASE = { clientId: 'child1', bcbaId: 'staff1', authorizationIds: ['auth1'], units: 8 };

const book = (input, timeZone) => normalizeBookingInput({ ...BASE, ...input }, { timeZone });

test('a date-only booking lands on the date the admin chose, in every org timezone', () => {
  for (const tz of ZONES) {
    const appt = book({ startDate: '2026-09-12', endDate: '2026-09-12' }, tz);
    assert.deepEqual(
      coveredBusinessDates(appt.startAt, appt.endAt, tz),
      ['2026-09-12'],
      `expected 09/12 only in ${tz}`,
    );
    assert.equal(appt.timeSet, false, 'no clock time was supplied, so none is fabricated');
    assert.equal(appt.businessTimeZone, tz);
  }
});

test('a single-day appointment stays valid for the WHOLE business day and expires the next', () => {
  for (const tz of ZONES) {
    const appt = book({ startDate: '2026-09-12', endDate: '2026-09-12' }, tz);
    // appt.startAt IS org midnight of 09/12, so offsets from it are org-local
    // wall clocks on that business day — no second date library needed.
    const at = (dayOffset, hours, minutes = 0) =>
      new Date(appt.startAt.getTime() + dayOffset * 86400000 + (hours * 60 + minutes) * 60000);

    assert.equal(coversBusinessDay(appt.startAt, appt.endAt, tz, at(-1, 15)), false, `09/11 15:00 in ${tz}`);
    assert.equal(coversBusinessDay(appt.startAt, appt.endAt, tz, at(0, 0, 1)), true, `09/12 00:01 in ${tz}`);
    assert.equal(coversBusinessDay(appt.startAt, appt.endAt, tz, at(0, 9)), true, `09/12 09:00 in ${tz}`);
    assert.equal(coversBusinessDay(appt.startAt, appt.endAt, tz, at(0, 23, 30)), true, `09/12 23:30 in ${tz}`);
    assert.equal(coversBusinessDay(appt.startAt, appt.endAt, tz, at(1, 0, 30)), false, `09/13 00:30 in ${tz}`);
  }
});

test('a multi-day booking covers every scheduled date, end date INCLUSIVE', () => {
  for (const tz of ZONES) {
    const appt = book({ startDate: '2026-09-12', endDate: '2026-09-14' }, tz);
    assert.deepEqual(
      coveredBusinessDates(appt.startAt, appt.endAt, tz),
      ['2026-09-12', '2026-09-13', '2026-09-14'],
      `expected three days in ${tz}`,
    );
  }
});

test('the end date used to be discarded — a multi-day range must no longer collapse', () => {
  // The regression: `endDate` was computed and then dropped whenever no endTime
  // was supplied, so 09/12 → 09/14 was persisted as a units-long window on
  // 09/12. The booking form never sends a clock time, so this hit every
  // multi-day booking.
  const appt = book({ startDate: '2026-09-12', endDate: '2026-09-14' }, 'America/New_York');
  const spanDays = (appt.endAt - appt.startAt) / 86400000;
  assert.equal(spanDays, 3, 'three whole business days, not a 2-hour window');
});

test('a timed booking does not bleed into the next day from a non-UTC zone', () => {
  // 7:00 PM entered by an admin used to be stored as 19:00Z and then rendered
  // in the viewer's zone — which is how "September 13" appeared.
  for (const tz of ZONES) {
    const appt = book({ startDate: '2026-09-12', endDate: '2026-09-12', startTime: '19:00', endTime: '21:00' }, tz);
    assert.deepEqual(coveredBusinessDates(appt.startAt, appt.endAt, tz), ['2026-09-12'], `19:00 booking in ${tz}`);
    assert.equal(appt.timeSet, true);
  }
});

test('an inverted date range is rejected rather than silently accepted', () => {
  assert.throws(
    () => book({ startDate: '2026-09-14', endDate: '2026-09-12' }, 'America/New_York'),
    (e) => e.code === 'END_BEFORE_START',
  );
});

test('a date-only appointment spanning days passes the same-day rule; a timed one does not', () => {
  const tz = 'America/New_York';
  const dateOnly = book({ startDate: '2026-09-12', endDate: '2026-09-14' }, tz);
  // Exempt: a whole-business-day appointment has no clock time to check against
  // a per-weekday availability window.
  assert.equal(validateTimeRange(dateOnly.startAt, dateOnly.endAt, { timeZone: tz, timeSet: false }), 3 * 1440);

  // A TIMED appointment must still sit inside one business day.
  assert.throws(
    () => validateTimeRange(
      new Date('2026-09-12T18:00:00Z'), new Date('2026-09-14T18:00:00Z'),
      { timeZone: tz, timeSet: true },
    ),
    (e) => e.code === 'INVALID_TIME_RANGE',
  );
});

test('a US-evening appointment that crosses UTC midnight is no longer rejected', () => {
  // 8pm–10pm New York is 00:00–02:00 UTC the NEXT day. The old same-UTC-day
  // rule refused it outright.
  const tz = 'America/New_York';
  const appt = book({ startDate: '2026-09-12', endDate: '2026-09-12', startTime: '20:00', endTime: '22:00' }, tz);
  assert.equal(appt.startAt.toISOString(), '2026-09-13T00:00:00.000Z', 'genuinely crosses UTC midnight');
  assert.equal(validateTimeRange(appt.startAt, appt.endAt, { timeZone: tz, timeSet: true }), 120);
  assert.deepEqual(coveredBusinessDates(appt.startAt, appt.endAt, tz), ['2026-09-12']);
});

// --- the Start gate, through the REAL service -------------------------------

const TENANT = 'org1';
const BCBA = 'staff1';

function apptDoc(booked, extra = {}) {
  return {
    id: 'appt_1', tenantId: TENANT, clientId: 'child1', bcbaId: BCBA, rbtId: null,
    staffProfileId: BCBA, startAt: booked.startAt, endAt: booked.endAt, timeSet: booked.timeSet,
    businessTimeZone: booked.businessTimeZone, authorizationId: 'auth1', authorizationIds: ['auth1'],
    units: 8, status: 'SCHEDULED', ...extra,
  };
}

test("today's appointment is startable today — the reported \"Not available for today\"", async () => {
  for (const tz of ZONES) {
    const booked = book({ startDate: '2026-09-12', endDate: '2026-09-12' }, tz);
    // 09:00 org-local on 09/12.
    const nineAm = new Date(booked.startAt.getTime() + 9 * 3600000);
    const h = createHarness({ timeZone: tz, now: nineAm.toISOString(), appointment: apptDoc(booked) });
    const session = await h.service.startSession({
      tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1',
    });
    assert.equal(session.status, 'IN_PROGRESS', `should be startable on 09/12 in ${tz}`);
  }
});

test('a multi-day appointment is startable on every day in its range, and expires after it', async () => {
  const tz = 'America/New_York';
  const booked = book({ startDate: '2026-09-12', endDate: '2026-09-14' }, tz);

  for (const dayOffset of [0, 1, 2]) {
    const at = new Date(booked.startAt.getTime() + dayOffset * 86400000 + 10 * 3600000);
    const h = createHarness({ timeZone: tz, now: at.toISOString(), appointment: apptDoc(booked) });
    const session = await h.service.startSession({
      tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1',
    });
    assert.equal(session.status, 'IN_PROGRESS', `day +${dayOffset} should be startable`);
  }

  // 09/15 is expired.
  const after = new Date(booked.startAt.getTime() + 3 * 86400000 + 10 * 3600000);
  const h = createHarness({ timeZone: tz, now: after.toISOString(), appointment: apptDoc(booked) });
  await assert.rejects(
    () => h.service.startSession({ tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' }),
    (e) => e.code === 'APPOINTMENT_NOT_TODAY',
  );
});

test('a running session can still be stopped after the business day has rolled over', async () => {
  // The day gate applies to STARTING a new session only — a clinician working
  // across midnight must never lose their session.
  const tz = 'America/New_York';
  const booked = book({ startDate: '2026-09-12', endDate: '2026-09-12' }, tz);
  const h = createHarness({
    timeZone: tz,
    now: new Date(booked.startAt.getTime() + 23 * 3600000).toISOString(), // 23:00 local
    appointment: apptDoc(booked),
  });
  const call = { tenantId: TENANT, actorUserId: 'u1', bcbaStaffProfileId: BCBA, appointmentId: 'appt_1' };
  await h.service.startSession(call);
  h.clock.advanceMinutes(120); // now 01:00 on 09/13
  const stopped = await h.service.stopSession(call);
  assert.equal(stopped.workedMinutes, 120);
});

// --- migration --------------------------------------------------------------

test('the migration re-anchors a legacy date-only row to the right business day', () => {
  const tz = 'America/New_York';
  // What the old booking core wrote for "09/12, date-only, 8 units".
  const legacy = { startAt: new Date('2026-09-12T00:00:00Z'), endAt: new Date('2026-09-12T02:00:00Z'), timeSet: false };
  const fixed = reanchor(legacy, tz);

  assert.equal(fixed.startAt.toISOString(), '2026-09-12T04:00:00.000Z');
  assert.equal(fixed.endAt.toISOString(), '2026-09-13T04:00:00.000Z');
  assert.deepEqual(coveredBusinessDates(fixed.startAt, fixed.endAt, tz), ['2026-09-12']);
  assert.equal(fixed.recoverable, false, 'a legacy multi-day end date cannot be recovered and is flagged');
});

test('the migration preserves the wall clock an admin typed for a timed row', () => {
  const tz = 'America/New_York';
  const legacy = { startAt: new Date('2026-09-12T19:00:00Z'), endAt: new Date('2026-09-12T21:00:00Z'), timeSet: true };
  const fixed = reanchor(legacy, tz);

  // 19:00 stays 19:00 — in New York now, rather than in UTC.
  assert.equal(fixed.startAt.toISOString(), '2026-09-12T23:00:00.000Z');
  assert.equal(fixed.endAt.toISOString(), '2026-09-13T01:00:00.000Z');
  assert.deepEqual(coveredBusinessDates(fixed.startAt, fixed.endAt, tz), ['2026-09-12']);
});

test('the migration is a no-op for a UTC organization', () => {
  const legacy = { startAt: new Date('2026-09-12T19:00:00Z'), endAt: new Date('2026-09-12T21:00:00Z'), timeSet: true };
  const fixed = reanchor(legacy, 'UTC');
  assert.equal(fixed.startAt.toISOString(), legacy.startAt.toISOString());
  assert.equal(fixed.endAt.toISOString(), legacy.endAt.toISOString());
});

test('the migration classifies a mixed batch into the categories it reports', () => {
  // The dry run reports: re-anchored, already correct, and date-only rows whose
  // original end date is unrecoverable. This exercises that classification over
  // a representative batch so the reported numbers are known to be derived, not
  // guessed. (Running it against a database is a separate step — see the
  // packaging report.)
  const tz = 'America/New_York';
  const batch = [
    { id: 'a', startAt: new Date('2026-09-12T00:00:00Z'), endAt: new Date('2026-09-12T02:00:00Z'), timeSet: false },
    { id: 'b', startAt: new Date('2026-09-13T00:00:00Z'), endAt: new Date('2026-09-13T02:00:00Z'), timeSet: false },
    { id: 'c', startAt: new Date('2026-09-12T19:00:00Z'), endAt: new Date('2026-09-12T21:00:00Z'), timeSet: true },
    { id: 'd', startAt: new Date('2026-09-12T14:00:00Z'), endAt: new Date('2026-09-12T16:00:00Z'), timeSet: true },
  ];

  let shifted = 0; let unchanged = 0; let unrecoverable = 0;
  for (const row of batch) {
    const next = reanchor(row, tz);
    assert.ok(next, 'every dated row must resolve');
    if (!next.recoverable) unrecoverable += 1;
    const moved = next.startAt.getTime() !== row.startAt.getTime()
      || next.endAt.getTime() !== row.endAt.getTime();
    if (moved) shifted += 1; else unchanged += 1;
  }

  assert.equal(shifted, 4, 'all four rows are UTC-composed and need re-anchoring in New York');
  assert.equal(unchanged, 0);
  assert.equal(unrecoverable, 2, 'the two date-only rows lost their end date and need manual review');

  // A UTC organization's rows are already correct and must be left alone.
  const utcUnchanged = batch.filter((row) => {
    const next = reanchor(row, 'UTC');
    return next.startAt.getTime() === row.startAt.getTime() && next.endAt.getTime() === row.endAt.getTime();
  });
  assert.equal(utcUnchanged.length, 2, 'timed UTC rows are already correct');
});

// --- organization timezone validation --------------------------------------
import { isValidTimeZone } from '../src/domain/businessDate.js';
import { updateProfileSchema } from '../src/modules/organization/organization.schemas.js';

test('isValidTimeZone accepts IANA identifiers and rejects offsets, abbreviations and free text', () => {
  for (const ok of ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu', 'America/Argentina/Buenos_Aires', 'Asia/Kolkata', 'Etc/GMT+5', 'UTC']) {
    assert.equal(isValidTimeZone(ok), true, ok);
  }
  for (const bad of ['Mars/Olympus', 'EST', '+05:00', 'UTC-4', 'america/new_york', 'Eastern Time', '', ' America/New_York', null, undefined, 42]) {
    assert.equal(isValidTimeZone(bad), false, String(bad));
  }
});

test('company profile update schema validates the timezone server-side', () => {
  assert.equal(updateProfileSchema.safeParse({ timezone: 'America/Chicago' }).success, true);
  const trimmed = updateProfileSchema.safeParse({ timezone: '  America/Denver ' });
  assert.equal(trimmed.success, true);
  assert.equal(trimmed.data.timezone, 'America/Denver');
  const bad = updateProfileSchema.safeParse({ timezone: 'Eastern Time' });
  assert.equal(bad.success, false);
  assert.deepEqual(bad.error.flatten().fieldErrors.timezone, ['Choose a valid time zone.']);
});
