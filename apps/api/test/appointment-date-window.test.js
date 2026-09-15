import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SchedulingService } from '../src/modules/scheduling/scheduling.service.js';
import { assertNewAppointmentDates, currentMonthBookingWindow, normalizeBookingInput } from '../src/modules/scheduling/booking.js';
import { zonedWallTimeToUtc } from '../src/domain/businessDate.js';

/**
 * ---------------------------------------------------------------------------
 * NEW APPOINTMENT DATE WINDOW — today through the end of the CURRENT month,
 * organization timezone, server clock. Enforced in SchedulingService.
 * bookAppointment (the New Appointment API) before any read or write; submitted
 * dates are refused, never adjusted; existing appointments are untouched.
 * The clock is pinned per test — "today" is never hardcoded in the service.
 * ---------------------------------------------------------------------------
 */

const TZ = 'America/New_York';
const wall = (date, hh, mm = 0) => { const [y, m, d] = date.split('-').map(Number); return zonedWallTimeToUtc(y, m, d, hh, mm, 0, TZ); };
const TODAY = wall('2026-09-13', 10); // 09/13/2026 10:00 AM ET

const CLIENT = 'child-1';
const BCBA = 'bcba-1';
const AUTH = 'svc:auth-1';

function makeService({ now = TODAY, historical = [] } = {}) {
  const created = [];
  const store = new Map(historical.map((a) => [a.id, a]));
  const service = new SchedulingService({
    clock: { now: () => now },
    repository: {
      findAuthorizationById: async () => ({ id: AUTH, clientId: CLIENT, status: 'ACTIVE', startDate: '2026-01-01', endDate: '2026-12-31', authorizedUnits: 400, usedUnits: 0 }),
      createAppointmentSimple: async (_t, doc) => { const a = { id: `appt-${created.length + 1}`, ...doc }; created.push(a); store.set(a.id, a); return a; },
      findAppointmentById: async (_t, id) => store.get(id) ?? null,
    },
    organizations: { getById: async () => ({ state: 'ACTIVE', timezone: TZ }) },
    clients: { findById: async () => ({ id: CLIENT, status: 'ACTIVE' }) },
    assignments: { listActiveForClient: async () => [{ staffProfileId: BCBA, role: 'BCBA', status: 'ACTIVE' }] },
  });
  return { service, created, store };
}
const book = (service, dates) => service.bookAppointment({
  tenantId: 't', actorUserId: 'u',
  input: { clientId: CLIENT, bcbaId: BCBA, authorizationIds: [AUTH], units: 4, ...dates },
});
const rejects422 = (p, code) => assert.rejects(p, (e) => { assert.equal(e.status, 422); assert.equal(e.code, code); return true; });

// --- the window ---------------------------------------------------------------

test('window = today → last day of the current month (org timezone), computed from the clock', () => {
  assert.deepEqual(currentMonthBookingWindow(TZ, TODAY), { today: '2026-09-13', lastAllowed: '2026-09-30' });
  // February of a leap year, and a month with 31 days.
  assert.equal(currentMonthBookingWindow('UTC', new Date('2028-02-10T12:00:00Z')).lastAllowed, '2028-02-29');
  assert.equal(currentMonthBookingWindow('UTC', new Date('2026-10-02T12:00:00Z')).lastAllowed, '2026-10-31');
  // Org timezone decides "today": 09/30 11:30 PM ET is already 10/01 in UTC.
  assert.deepEqual(currentMonthBookingWindow(TZ, wall('2026-09-30', 23, 30)), { today: '2026-09-30', lastAllowed: '2026-09-30' });
});

// --- service: accepted --------------------------------------------------------

test('today is allowed', async () => {
  const { service, created } = makeService();
  await book(service, { startDate: '2026-09-13', endDate: '2026-09-13' });
  assert.equal(created.length, 1);
});

test('a future date in the current month is allowed (incl. the last day)', async () => {
  const { service, created } = makeService();
  await book(service, { startDate: '2026-09-14' });
  await book(service, { startDate: '2026-09-30', endDate: '2026-09-30' });
  assert.equal(created.length, 2);
});

test('a current-month multi-date range works: 09/13 → 09/30', async () => {
  const { service, created } = makeService();
  const appt = await book(service, { startDate: '2026-09-13', endDate: '2026-09-30' });
  assert.equal(created.length, 1);
  assert.equal(appt.startAt.toISOString(), wall('2026-09-13', 0).toISOString());
  assert.equal(appt.endAt.toISOString(), wall('2026-10-01', 0).toISOString()); // exclusive end, unchanged
});

test('a timed booking later today is allowed even when it is already tomorrow in UTC', async () => {
  const { service, created } = makeService({ now: wall('2026-09-13', 18) });
  await book(service, { startDate: '2026-09-13', startTime: '21:00', endTime: '22:00' });
  assert.equal(created.length, 1);
});

// --- service: refused (nothing written, nothing adjusted) ---------------------

test('a past date is rejected (yesterday)', async () => {
  const { service, created } = makeService();
  await rejects422(book(service, { startDate: '2026-09-12', endDate: '2026-09-12' }), 'APPOINTMENT_DATE_IN_PAST');
  assert.equal(created.length, 0);
});

test('a previous month is rejected', async () => {
  const { service, created } = makeService();
  await rejects422(book(service, { startDate: '2026-08-20', endDate: '2026-08-21' }), 'APPOINTMENT_DATE_IN_PAST');
  assert.equal(created.length, 0);
});

test('next month is rejected (10/01)', async () => {
  const { service, created } = makeService();
  await rejects422(book(service, { startDate: '2026-10-01', endDate: '2026-10-01' }), 'APPOINTMENT_DATE_OUTSIDE_CURRENT_MONTH');
  assert.equal(created.length, 0);
});

test('later future months are rejected', async () => {
  const { service, created } = makeService();
  for (const startDate of ['2026-11-05', '2027-01-15', '2027-09-13']) {
    await rejects422(book(service, { startDate }), 'APPOINTMENT_DATE_OUTSIDE_CURRENT_MONTH');
  }
  assert.equal(created.length, 0);
});

test('a range containing a past date is rejected: 09/12 → 09/20', async () => {
  const { service, created } = makeService();
  await rejects422(book(service, { startDate: '2026-09-12', endDate: '2026-09-20' }), 'APPOINTMENT_DATE_IN_PAST');
  assert.equal(created.length, 0);
});

test('a range crossing into next month is rejected: 09/13 → 10/05', async () => {
  const { service, created } = makeService();
  await rejects422(book(service, { startDate: '2026-09-13', endDate: '2026-10-05' }), 'APPOINTMENT_DATE_OUTSIDE_CURRENT_MONTH');
  assert.equal(created.length, 0);
});

test('the date window is checked before any other lookup (no reads of client/assignments/authorizations)', async () => {
  const calls = [];
  const svc = new SchedulingService({
    clock: { now: () => TODAY },
    repository: { findAuthorizationById: async () => { calls.push('auth'); return null; }, createAppointmentSimple: async () => { calls.push('create'); } },
    organizations: { getById: async () => ({ state: 'ACTIVE', timezone: TZ }) },
    clients: { findById: async () => { calls.push('client'); return null; } },
    assignments: { listActiveForClient: async () => { calls.push('assign'); return []; } },
  });
  await rejects422(book(svc, { startDate: '2026-09-01' }), 'APPOINTMENT_DATE_IN_PAST');
  assert.deepEqual(calls, []);
});

test('the pure rule mirrors the service (and accepts real instants from the normalizer)', () => {
  const ok = normalizeBookingInput({ clientId: CLIENT, bcbaId: BCBA, authorizationIds: [AUTH], units: 4, startDate: '2026-09-13', endDate: '2026-09-30' }, { timeZone: TZ });
  assert.deepEqual(assertNewAppointmentDates({ ...ok, timeZone: TZ, now: TODAY }), { today: '2026-09-13', lastAllowed: '2026-09-30', firstDate: '2026-09-13', lastDate: '2026-09-30' });
  const crossing = normalizeBookingInput({ clientId: CLIENT, bcbaId: BCBA, authorizationIds: [AUTH], units: 4, startDate: '2026-09-30', endDate: '2026-10-01' }, { timeZone: TZ });
  assert.throws(() => assertNewAppointmentDates({ ...crossing, timeZone: TZ, now: TODAY }), (e) => e.code === 'APPOINTMENT_DATE_OUTSIDE_CURRENT_MONTH');
});

// --- existing appointments ------------------------------------------------------

test('existing historical appointments remain intact and readable (the rule only guards creation)', async () => {
  const past = { id: 'hist-1', clientId: CLIENT, bcbaId: BCBA, startAt: wall('2026-08-01', 0), endAt: wall('2026-08-02', 0), status: 'SCHEDULED', timeSet: false };
  const { service, store } = makeService({ historical: [past] });
  await rejects422(book(service, { startDate: '2026-08-01' }), 'APPOINTMENT_DATE_IN_PAST');
  const read = await service.getAppointment({ tenantId: 't', appointmentId: 'hist-1' });
  assert.equal(read.id, 'hist-1');
  assert.deepEqual(store.get('hist-1'), past, 'never rewritten or deleted');
});

test('the service source applies the window on the create path only', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/modules/scheduling/scheduling.service.js', import.meta.url), 'utf8');
  assert.equal(src.match(/assertNewAppointmentDates\(/g).length, 1);
  const bookStart = src.indexOf('async bookAppointment(');
  const call = src.indexOf('assertNewAppointmentDates(');
  const next = src.indexOf('\n  async ', bookStart + 10);
  assert.ok(call > bookStart && call < next, 'called inside bookAppointment');
});
