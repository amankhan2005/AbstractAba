import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePayrollWindow, aggregatePeriodPayroll } from '../src/modules/payroll/payroll.periods.js';

/**
 * Company Admin period payroll (spec §1–§10, §15, §24). DB-free: period windows
 * are resolved by the pure resolver and payroll is shaped by the pure
 * aggregator — the same functions the service calls after it fetches the
 * authoritative SessionTimeRecord rows.
 */

// ---- period resolution (§1/§15) ------------------------------------------
test('weekly window is the company week containing the anchor (Sunday start, UTC)', () => {
  // 2026-09-09 is a Wednesday. Week (Sun→Sat) is 2026-09-06 .. 2026-09-13.
  const w = resolvePayrollWindow({ mode: 'weekly', anchor: '2026-09-09', timeZone: 'UTC', weekStartsOn: 0 });
  assert.equal(w.start.toISOString(), '2026-09-06T00:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-09-13T00:00:00.000Z'); // half-open
  assert.equal(w.mode, 'weekly');
});

test('bi-weekly window is the fixed 14-day pay period containing the anchor (non-overlapping)', () => {
  // Monday-start cycle: … 08/24–09/06 | 09/07–09/20 | 09/21–10/04 …
  const w = resolvePayrollWindow({ mode: 'biweekly', anchor: '2026-09-09T12:00:00Z', timeZone: 'UTC', weekStartsOn: 1 });
  assert.equal(w.start.toISOString(), '2026-09-07T00:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-09-21T00:00:00.000Z');
  // Both weeks of a period resolve to the SAME period (it does not slide weekly).
  const second = resolvePayrollWindow({ mode: 'biweekly', anchor: '2026-09-16T12:00:00Z', timeZone: 'UTC', weekStartsOn: 1 });
  assert.equal(second.start.toISOString(), w.start.toISOString());
  assert.equal(second.end.toISOString(), w.end.toISOString());
});

test('custom window is inclusive of the whole end day (half-open at end+1)', () => {
  const w = resolvePayrollWindow({ mode: 'custom', from: '2026-09-01', to: '2026-09-07', timeZone: 'UTC' });
  assert.equal(w.start.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-09-08T00:00:00.000Z'); // 07 fully included
});

test('custom rejects an inverted range (startDate must be <= endDate)', () => {
  assert.throws(() => resolvePayrollWindow({ mode: 'custom', from: '2026-09-10', to: '2026-09-01' }), /From Date must be on or before To Date/);
});

test('custom requires both dates', () => {
  assert.throws(() => resolvePayrollWindow({ mode: 'custom', from: '2026-09-01' }), /Select a From Date and a To Date/);
});

test('weekly honours a non-UTC timezone boundary (America/New_York)', () => {
  // Sun 2026-09-06 00:00 in New York is 04:00 UTC (EDT, -4).
  const w = resolvePayrollWindow({ mode: 'weekly', anchor: '2026-09-09', timeZone: 'America/New_York', weekStartsOn: 0 });
  assert.equal(w.start.toISOString(), '2026-09-06T04:00:00.000Z');
});

// ---- aggregation (§3–§10, §24) -------------------------------------------
const APPT_B = 'appt-bcba';
const APPT_R = 'appt-rbt';
const apptById = new Map([
  [APPT_B, { _id: APPT_B, bcbaId: 'bcba-1', rbtId: null }],
  [APPT_R, { _id: APPT_R, bcbaId: null, rbtId: 'rbt-1' }],
]);
const staffById = new Map([
  ['bcba-1', { _id: 'bcba-1', firstName: 'John', lastName: 'Smith' }],
  ['rbt-1', { _id: 'rbt-1', firstName: 'Sarah', lastName: 'Williams' }],
]);
const clientNameById = new Map([['child-A', 'Child A']]);
const window = { start: new Date('2026-09-06T00:00:00Z'), end: new Date('2026-09-13T00:00:00Z') };

// The deterministic case from the spec: BCBA 90m@$50=$75.00, RBT 150m@$25=$62.50.
const records = [
  { sessionId: 's-b', appointmentId: APPT_B, staffProfileId: 'bcba-1', clientId: 'child-A', startedAt: new Date('2026-09-07T10:00:00Z'), endedAt: new Date('2026-09-07T11:30:00Z'), workedMinutes: 90, hourlyRateSnapshot: 5000, amount: 7500, currency: 'usd' },
  { sessionId: 's-r', appointmentId: APPT_R, staffProfileId: 'rbt-1', clientId: 'child-A', startedAt: new Date('2026-09-07T10:15:00Z'), endedAt: new Date('2026-09-07T12:45:00Z'), workedMinutes: 150, hourlyRateSnapshot: 2500, amount: 6250, currency: 'usd' },
];

test('§24 deterministic — BCBA $75.00, RBT $62.50, company $137.50, minutes never merged', () => {
  const { staff, summary } = aggregatePeriodPayroll({ records, apptById, staffById, clientNameById, window });
  const bcba = staff.find((s) => s.staffProfileId === 'bcba-1');
  const rbt = staff.find((s) => s.staffProfileId === 'rbt-1');
  assert.equal(bcba.role, 'BCBA');
  assert.equal(bcba.workedMinutes, 90);
  assert.equal(bcba.amount, 7500);
  assert.equal(rbt.role, 'RBT');
  assert.equal(rbt.workedMinutes, 150);
  assert.equal(rbt.amount, 6250);
  // No 240-minute combined record anywhere.
  assert.ok(!staff.some((s) => s.workedMinutes === 240));
  assert.equal(summary.staffCount, 2);
  assert.equal(summary.bcbaCount, 1);
  assert.equal(summary.rbtCount, 1);
  assert.equal(summary.sessionCount, 2);
  assert.equal(summary.totalMinutes, 240);
  assert.equal(summary.totalAmount, 13750); // $137.50
});

test('multiple sessions per clinician aggregate; drill-down keeps each session', () => {
  const many = [
    { sessionId: 's1', appointmentId: APPT_R, staffProfileId: 'rbt-1', clientId: 'child-A', startedAt: new Date('2026-09-07T09:00:00Z'), endedAt: new Date('2026-09-07T10:30:00Z'), workedMinutes: 90, hourlyRateSnapshot: 2800, amount: 4200, currency: 'usd' },
    { sessionId: 's2', appointmentId: APPT_R, staffProfileId: 'rbt-1', clientId: 'child-A', startedAt: new Date('2026-09-08T10:00:00Z'), endedAt: new Date('2026-09-08T12:00:00Z'), workedMinutes: 120, hourlyRateSnapshot: 2800, amount: 5600, currency: 'usd' },
  ];
  const { staff, summary } = aggregatePeriodPayroll({ records: many, apptById, staffById, clientNameById, window });
  assert.equal(staff.length, 1);
  assert.equal(staff[0].sessionCount, 2);
  assert.equal(staff[0].workedMinutes, 210);
  assert.equal(staff[0].amount, 9800);       // 42.00 + 56.00
  assert.equal(staff[0].hourlyRate, 2800);   // single rate → shown
  assert.equal(staff[0].entries.length, 2);
  assert.equal(staff[0].entries[0].childName, 'Child A');
  assert.equal(summary.totalAmount, 9800);
});

test('§19 — a record with no rate is flagged missingRate and never paid $0 silently', () => {
  const noRate = [{ sessionId: 's-x', appointmentId: APPT_R, staffProfileId: 'rbt-1', clientId: 'child-A', startedAt: new Date('2026-09-07T09:00:00Z'), endedAt: new Date('2026-09-07T10:00:00Z'), workedMinutes: 60, hourlyRateSnapshot: null, amount: null, currency: 'usd' }];
  const { staff, summary } = aggregatePeriodPayroll({ records: noRate, apptById, staffById, clientNameById, window });
  assert.equal(staff[0].missingRate, true);
  assert.equal(staff[0].amount, 0);
  assert.equal(staff[0].entries[0].amount, null); // not a fabricated $0
  assert.equal(summary.missingRateCount, 1);
});

test('§22 deterministic — Staff Profile rate $30/hr × 3 min = $1.50 (the No-rate fix)', () => {
  // Session snapshot is NULL (never frozen) — the authoritative Staff Profile
  // rate must still resolve and compute the amount, never "No rate".
  const recs = [{ sessionId: 's', appointmentId: APPT_R, staffProfileId: 'rbt-1', clientId: 'child-A', startedAt: new Date('2026-09-07T17:31:00Z'), endedAt: new Date('2026-09-07T17:34:00Z'), workedMinutes: 3, hourlyRateSnapshot: null, amount: null }];
  const rateByStaff = new Map([['rbt-1', 3000]]); // $30.00/hr, cents
  const { staff, summary } = aggregatePeriodPayroll({ records: recs, apptById, staffById, clientNameById, rateByStaff, window });
  assert.equal(staff[0].missingRate, false);
  assert.equal(staff[0].hourlyRate, 3000);
  assert.equal(staff[0].amount, 150);      // $1.50
  assert.equal(staff[0].entries[0].amount, 150);
  assert.equal(summary.totalAmount, 150);
});

test('§22 — the Staff Profile rate overrides a stale per-session snapshot', () => {
  const recs = [{ sessionId: 's', appointmentId: APPT_B, staffProfileId: 'bcba-1', clientId: 'child-A', startedAt: new Date('2026-09-07T10:00:00Z'), endedAt: new Date('2026-09-07T11:30:00Z'), workedMinutes: 90, hourlyRateSnapshot: 9999, amount: 99999 }];
  const rateByStaff = new Map([['bcba-1', 5000]]); // $50/hr wins over the snapshot
  const { staff } = aggregatePeriodPayroll({ records: recs, apptById, staffById, clientNameById, rateByStaff, window });
  assert.equal(staff[0].hourlyRate, 5000);
  assert.equal(staff[0].amount, 7500); // 90 min × $50 = $75.00, not the snapshot
});

test('§19 — missingRate only when the staff genuinely has no rate (null in the map)', () => {
  const recs = [{ sessionId: 's', appointmentId: APPT_R, staffProfileId: 'rbt-1', clientId: 'child-A', startedAt: new Date('2026-09-07T09:00:00Z'), endedAt: new Date('2026-09-07T10:00:00Z'), workedMinutes: 60, hourlyRateSnapshot: null, amount: null }];
  const rateByStaff = new Map([['rbt-1', null]]);
  const { staff, summary } = aggregatePeriodPayroll({ records: recs, apptById, staffById, clientNameById, rateByStaff, window });
  assert.equal(staff[0].missingRate, true);
  assert.equal(staff[0].amount, 0);
  assert.equal(staff[0].entries[0].amount, null);
  assert.equal(summary.missingRateCount, 1);
});

test('payroll drill-down entries carry scheduled time from the appointment (Part 7)', () => {
  const appts = new Map([['appt-r', { _id: 'appt-r', bcbaId: null, rbtId: 'rbt-1', startAt: new Date('2026-09-07T12:00:00Z'), endAt: new Date('2026-09-07T13:00:00Z'), timeSet: true }]]);
  const recs = [{ sessionId: 's', appointmentId: 'appt-r', staffProfileId: 'rbt-1', clientId: 'child-A', startedAt: new Date('2026-09-07T12:03:00Z'), endedAt: new Date('2026-09-07T12:58:00Z'), workedMinutes: 55, hourlyRateSnapshot: null }];
  const rateByStaff = new Map([['rbt-1', 3000]]);
  const { staff } = aggregatePeriodPayroll({ records: recs, apptById: appts, staffById, clientNameById, rateByStaff, window });
  const e = staff[0].entries[0];
  assert.equal(e.scheduledStart.toISOString(), '2026-09-07T12:00:00.000Z'); // appointment
  assert.equal(e.scheduledTimeSet, true);
  assert.equal(e.clockInAt.toISOString(), '2026-09-07T12:03:00.000Z');       // actual
  assert.equal(e.workedMinutes, 55);
});

test('a date-only payroll appointment yields scheduledTimeSet:false (no fake midnight)', () => {
  const appts = new Map([['appt-d', { _id: 'appt-d', rbtId: 'rbt-1', startAt: new Date('2026-09-07T00:00:00Z'), timeSet: false }]]);
  const recs = [{ sessionId: 's', appointmentId: 'appt-d', staffProfileId: 'rbt-1', clientId: 'child-A', startedAt: new Date('2026-09-07T09:00:00Z'), endedAt: new Date('2026-09-07T10:00:00Z'), workedMinutes: 60, hourlyRateSnapshot: 3000 }];
  const { staff } = aggregatePeriodPayroll({ records: recs, apptById: appts, staffById, clientNameById, window });
  assert.equal(staff[0].entries[0].scheduledTimeSet, false);
});

test('weekly window is MONDAY→SUNDAY when weekStartsOn=1 (payroll standard, spec §4)', () => {
  // 2026-09-09 is a Wednesday → Mon 09/07 .. Sun 09/13 (half-open at Mon 09/14).
  const w = resolvePayrollWindow({ mode: 'weekly', anchor: '2026-09-09', timeZone: 'UTC', weekStartsOn: 1 });
  assert.equal(w.start.toISOString(), '2026-09-07T00:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-09-14T00:00:00.000Z');
});

test('§22 calculation examples — 3/75/183 min × $30 = $1.50 / $37.50 / $91.50', () => {
  const appts = new Map([['ap', { _id: 'ap', bcbaId: 'bcba-1', rbtId: null }]]);
  const staffByIdX = new Map([['bcba-1', { _id: 'bcba-1', firstName: 'A', lastName: 'B' }]]);
  const rate = new Map([['bcba-1', 3000]]); // $30/hr
  const win = { start: new Date('2026-09-07T00:00:00Z'), end: new Date('2026-09-14T00:00:00Z') };
  const run = (mins) => aggregatePeriodPayroll({
    records: [{ sessionId: 's', appointmentId: 'ap', staffProfileId: 'bcba-1', clientId: 'c', startedAt: new Date('2026-09-08T10:00:00Z'), workedMinutes: mins, hourlyRateSnapshot: null }],
    apptById: appts, staffById: staffByIdX, clientNameById: new Map(), rateByStaff: rate, window: win,
  }).summary.totalAmount;
  assert.equal(run(3), 150);    // $1.50
  assert.equal(run(75), 3750);  // $37.50
  assert.equal(run(183), 9150); // $91.50
});

test('staff name renders First Middle Last (spec §10)', () => {
  const { staff } = aggregatePeriodPayroll({
    records: [{ sessionId: 's', appointmentId: 'ap', staffProfileId: 'bcba-1', clientId: 'c', startedAt: new Date('2026-09-08T10:00:00Z'), workedMinutes: 60, hourlyRateSnapshot: 3000 }],
    apptById: new Map([['ap', { _id: 'ap', bcbaId: 'bcba-1', rbtId: null }]]),
    staffById: new Map([['bcba-1', { _id: 'bcba-1', firstName: 'Jackie', middleName: 'Marie', lastName: 'More' }]]),
    clientNameById: new Map(), rateByStaff: new Map([['bcba-1', 3000]]), window: { start: new Date('2026-09-07T00:00:00Z'), end: new Date('2026-09-14T00:00:00Z') },
  });
  assert.equal(staff[0].staffName, 'Jackie Marie More'); // no comma, middle included
});

test('empty period → zeroed summary, no fabricated rows', () => {
  const { staff, summary } = aggregatePeriodPayroll({ records: [], apptById, staffById, clientNameById, window });
  assert.equal(staff.length, 0);
  assert.equal(summary.staffCount, 0);
  assert.equal(summary.totalAmount, 0);
  assert.equal(summary.sessionCount, 0);
});

// ---- ROOT-CAUSE regression: RBT must appear alongside BCBA (spec §7/§23) -----
// The pure aggregator is what the (now session-driven) service feeds. These
// lock in: (a) the care-team ROLE FALLBACK used when an appointment does not
// itself carry bcbaId/rbtId — the exact case for a session frozen through the
// standard review flow — and (b) the spec §23 deterministic payroll figures.
test('care-team role fallback classifies RBT even when the appointment omits rbtId', () => {
  const window = { start: new Date('2026-08-31T00:00:00Z'), end: new Date('2026-09-07T00:00:00Z') };
  // Appointment carries NEITHER bcbaId nor rbtId (legacy / review-frozen session).
  const apptById = new Map([['ap-x', { _id: 'ap-x', bcbaId: null, rbtId: null }]]);
  const staffById = new Map([['rbt-1', { _id: 'rbt-1', firstName: 'Mike', middleName: 'Andrew', lastName: 'Johnson' }]]);
  const clientNameById = new Map([['child-A', 'John Doe']]);
  const rateByStaff = new Map([['rbt-1', 2500]]);
  const roleByStaffId = new Map([['rbt-1', 'RBT']]); // authoritative care-team role
  const records = [{ sessionId: 's1', staffProfileId: 'rbt-1', appointmentId: 'ap-x', clientId: 'child-A', startedAt: new Date('2026-09-02T14:00:00Z'), endedAt: new Date('2026-09-02T16:00:00Z'), workedMinutes: 120, hourlyRateSnapshot: null }];
  const { staff, summary } = aggregatePeriodPayroll({ records, apptById, staffById, clientNameById, rateByStaff, roleByStaffId, window });
  assert.equal(staff.length, 1);
  assert.equal(staff[0].role, 'RBT', 'role resolved from care-team fallback');
  assert.equal(summary.rbtCount, 1);
  assert.equal(summary.bcbaCount, 0);
});

test('spec §23 deterministic payroll: BCBA 90m@$50=$75, RBT 120m@$25=$50, total $125', () => {
  const window = { start: new Date('2026-08-31T00:00:00Z'), end: new Date('2026-09-07T00:00:00Z') };
  const apptById = new Map([
    ['ap-b', { _id: 'ap-b', bcbaId: 'bcba-1', rbtId: null }],
    ['ap-r', { _id: 'ap-r', bcbaId: null, rbtId: 'rbt-1' }],
  ]);
  const staffById = new Map([
    ['bcba-1', { _id: 'bcba-1', firstName: 'Sarah', middleName: 'Jane', lastName: 'Smith' }],
    ['rbt-1', { _id: 'rbt-1', firstName: 'Mike', middleName: 'Andrew', lastName: 'Johnson' }],
  ]);
  const clientNameById = new Map([['child-A', 'John Doe']]);
  const rateByStaff = new Map([['bcba-1', 5000], ['rbt-1', 2500]]);
  // NOTE: no hourlyRateSnapshot — mirrors a review-frozen session with no time
  // record; the effective staff rate must still resolve.
  const records = [
    { sessionId: 'sb', staffProfileId: 'bcba-1', appointmentId: 'ap-b', clientId: 'child-A', startedAt: new Date('2026-09-01T14:00:00Z'), endedAt: new Date('2026-09-01T15:30:00Z'), workedMinutes: 90, hourlyRateSnapshot: null },
    { sessionId: 'sr', staffProfileId: 'rbt-1', appointmentId: 'ap-r', clientId: 'child-A', startedAt: new Date('2026-09-02T14:00:00Z'), endedAt: new Date('2026-09-02T16:00:00Z'), workedMinutes: 120, hourlyRateSnapshot: null },
  ];
  const { staff, summary } = aggregatePeriodPayroll({ records, apptById, staffById, clientNameById, rateByStaff, window });
  const bcba = staff.find((s) => s.role === 'BCBA');
  const rbt = staff.find((s) => s.role === 'RBT');
  assert.ok(bcba && rbt, 'both BCBA and RBT present');
  assert.equal(bcba.staffName, 'Sarah Jane Smith');
  assert.equal(bcba.hourlyRate, 5000);
  assert.equal(bcba.amount, 7500); // 1.5h × $50.00
  assert.equal(rbt.staffName, 'Mike Andrew Johnson');
  assert.equal(rbt.hourlyRate, 2500);
  assert.equal(rbt.amount, 5000); // 2h × $25.00
  assert.equal(summary.totalAmount, 12500); // $125.00
  assert.equal(summary.bcbaCount, 1);
  assert.equal(summary.rbtCount, 1);
});

// ============ COMPLETED PERIODS · RATES · PAYOUT (Payroll final redesign) ============
import { periodPayroll, generatedPayroll, RECORDS } from './_payroll-fixture.js';

const NY = 'America/New_York';
const weekly = (now, extra = {}) => resolvePayrollWindow({ mode: 'weekly', now: new Date(now), timeZone: NY, weekStartsOn: 1, ...extra });
const biweekly = (now, extra = {}) => resolvePayrollWindow({ mode: 'biweekly', now: new Date(now), timeZone: NY, weekStartsOn: 1, ...extra });

test('weekly: on Tuesday 09/15 the payroll period is the previous completed Monday 09/07 → Sunday 09/13', () => {
  const w = weekly('2026-09-15T14:00:00Z'); // Tue 10:00 New York
  assert.deepEqual([w.from, w.to, w.label, w.completed], ['2026-09-07', '2026-09-13', '09/07/2026 – 09/13/2026', true]);
  assert.equal(w.start.toISOString(), '2026-09-07T04:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-09-14T04:00:00.000Z');
  assert.deepEqual([w.previousAnchor, w.nextAnchor], ['2026-08-31', null], 'the next week has not finished');
});

test('weekly: the current week (Mon 09/14 → Sun 09/20) is not paid until Sunday has ended', () => {
  assert.equal(weekly('2026-09-14T04:00:00Z').from, '2026-09-07', 'Monday 00:00 — the new week has only just started');
  assert.equal(weekly('2026-09-21T03:59:59Z').from, '2026-09-07', 'Sunday 23:59:59 — still not complete');
  const done = weekly('2026-09-21T04:00:00Z'); // Monday 09/21 00:00 New York
  assert.deepEqual([done.from, done.to], ['2026-09-14', '2026-09-20']);
  assert.throws(() => weekly('2026-09-15T14:00:00Z', { anchor: '2026-09-15', requireCompleted: true }), /This week has not finished yet/);
  assert.equal(weekly('2026-09-15T14:00:00Z', { anchor: '2026-09-02', requireCompleted: true }).from, '2026-08-31', 'an earlier completed week can be chosen');
});

test('bi-weekly: two completed Monday–Sunday weeks; a partly completed fortnight is never used', () => {
  const tue = biweekly('2026-09-15T14:00:00Z');
  assert.deepEqual([tue.from, tue.to], ['2026-08-24', '2026-09-06'], '09/07–09/20 is still in progress');
  assert.deepEqual([biweekly('2026-09-21T03:59:59Z').from, biweekly('2026-09-21T03:59:59Z').to], ['2026-08-24', '2026-09-06']);
  const done = biweekly('2026-09-21T04:00:00Z');
  assert.deepEqual([done.from, done.to, done.label], ['2026-09-07', '2026-09-20', '09/07/2026 – 09/20/2026']);
  assert.equal(done.end.getTime() - done.start.getTime(), 14 * 86400000);
  assert.throws(() => biweekly('2026-09-15T14:00:00Z', { anchor: '2026-09-15', requireCompleted: true }), /This pay period has not finished yet/);
});

test('custom: exact inclusive From–To range on the organization calendar; validation messages', () => {
  const c = resolvePayrollWindow({ mode: 'custom', from: '2026-09-09', to: '2026-09-11', timeZone: NY });
  assert.deepEqual([c.from, c.to, c.label], ['2026-09-09', '2026-09-11', '09/09/2026 – 09/11/2026']);
  assert.equal(c.start.toISOString(), '2026-09-09T04:00:00.000Z');
  assert.equal(c.end.toISOString(), '2026-09-12T04:00:00.000Z');
  assert.throws(() => resolvePayrollWindow({ mode: 'custom', to: '2026-09-11' }), /Select a From Date and a To Date/);
  assert.throws(() => resolvePayrollWindow({ mode: 'custom', from: '2026-09-12', to: '2026-09-11' }), /From Date must be on or before To Date/);
  assert.throws(() => resolvePayrollWindow({ mode: 'custom', from: '2026-02-30', to: '2026-03-01' }), /Enter a valid date/);
});

test('payout = actual worked minutes ÷ 60 × hourly rate — BCBA 6h 00m × $50 = $300.00, RBT 2h 30m × $25 = $62.50, total $362.50', () => {
  const { staff, summary } = periodPayroll(RECORDS.filter((r) => ['b1', 'r1'].includes(r.staffProfileId)));
  assert.deepEqual(staff.map((s) => [s.staffName, s.role, s.hourlyRates, s.workedMinutes, s.amount]), [['test1 j', 'BCBA', [5000], 360, 30000], ['Test2 K', 'RBT', [2500], 150, 6250]]);
  assert.equal(summary.totalAmount, 36250);
});

test('multiple staff with their own rates are never combined; BCBA first, then RBT', () => {
  const { staff, summary } = periodPayroll();
  assert.deepEqual(staff.map((s) => [s.staffName, s.role, s.hourlyRates, s.workedMinutes, s.amount]), [
    ['Ellen Ng', 'BCBA', [6000], 90, 9000],
    ['test1 j', 'BCBA', [5000], 360, 30000],
    ['Ann Lee', 'RBT', [3000], 45, 2250],
    ['Mark Ray', 'RBT', [3000, 3200], 120, 6200],
    ['Test2 K', 'RBT', [2500], 150, 6250],
  ]);
  assert.deepEqual([summary.staffCount, summary.bcbaCount, summary.rbtCount, summary.totalMinutes, summary.totalAmount], [5, 2, 3, 765, 53700]);
  assert.equal(summary.totalAmount, staff.reduce((t, s) => t + s.amount, 0));
});

test('a rate change mid-period: each day’s work is paid at the rate in effect on that day', () => {
  const mark = periodPayroll().staff.find((s) => s.staffName === 'Mark Ray');
  assert.deepEqual(mark.rateLines, [{ hourlyRate: 3000, workedMinutes: 60, amount: 3000 }, { hourlyRate: 3200, workedMinutes: 60, amount: 3200 }]);
  assert.deepEqual(mark.entries.map((e) => [e.hourlyRate, e.amount]), [[3000, 3000], [3200, 3200]]);
});

test('worked time is never rounded before the payout; the payout is rounded once', () => {
  // Nine 45-minute sessions except one of 44 → 404 minutes at $50/hr = $336.666… → $336.67.
  const rows = [45, 45, 45, 45, 45, 45, 45, 45, 44].map((m, i) => ({ sessionId: `x${i}`, staffProfileId: 'b1', appointmentId: 'a1', startedAt: new Date(`2026-09-${String(8 + (i % 5)).padStart(2, "0")}T13:00:00Z`), workedMinutes: m }));
  const b = periodPayroll(rows).staff[0];
  assert.deepEqual([b.workedMinutes, b.amount], [404, 33667]);
  assert.equal(b.entries.reduce((t, e) => t + e.amount, 0), 33667, 'session amounts add up exactly');
  // Per-session rounding would have given 9 × round(45/60 × 5000) … ≠ 33667.
});

test('a staff member with worked time but no hourly rate is flagged, never paid $0', () => {
  const { staff, summary } = aggregatePeriodPayroll({ records: [{ sessionId: 'z', staffProfileId: 'nobody', appointmentId: 'a1', startedAt: new Date('2026-09-08T13:00:00Z'), workedMinutes: 30 }], window });
  assert.deepEqual([staff[0].missingRate, staff[0].amount, staff[0].rateLines.length, summary.missingRateCount, summary.totalAmount], [true, 0, 0, 1, 0]);
});

test('the generated payroll carries only paid staff with their saved figures', () => {
  const g = generatedPayroll();
  assert.equal(g.summary.totalAmount, 53700);
  assert.deepEqual(g.staff.map((s) => s.workedMinutes), [90, 360, 45, 120, 150]);
});
