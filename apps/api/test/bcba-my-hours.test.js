import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  companyPeriodWindow, splitHms, humanHms, MY_HOURS_PERIODS,
} from '../src/modules/bcba-session/weeklyHours.js';
import { BcbaSessionService } from '../src/modules/bcba-session/bcbaSession.service.js';

/**
 * MY HOURS (spec Change 4) — DB-free tests for the period-window math, the exact
 * hours/minutes/seconds formatting, and the service read path (own-scope,
 * worked-time-only, no pay). The number is server-authoritative: it comes from
 * summed SessionTimeRecord seconds, never a browser timer.
 */

/** A service wired with fake ports for the my-hours read path only. */
function makeService({ timezone = 'America/New_York', staffing = {}, sum = { seconds: 0, sessions: 0 } } = {}) {
  const calls = { sum: [] };
  const svc = new BcbaSessionService({
    organizations: { getById: async () => ({ state: 'ACTIVE', timezone }) },
    settings: { getStaffing: async () => staffing },
    timeRecords: {
      sumWorkedSeconds: async (tenantId, opts) => { calls.sum.push({ tenantId, ...opts }); return sum; },
    },
    phi: { seal: (v) => v, open: (v) => v },
    clock: { now: () => new Date('2025-03-12T15:00:00.000Z') }, // Wed, during US DST
  });
  return { svc, calls };
}

// --- formatting -------------------------------------------------------------

test('humanHms always shows hours, minutes AND seconds (no rounding away seconds)', () => {
  assert.equal(humanHms(42 * 3600 + 17 * 60 + 38), '42h 17m 38s');
  assert.equal(humanHms(0), '0h 0m 0s');
  assert.equal(humanHms(59), '0h 0m 59s');
  assert.equal(humanHms(3600), '1h 0m 0s');
});

test('splitHms decomposes exact seconds', () => {
  assert.deepEqual(splitHms(3661), { hours: 1, minutes: 1, seconds: 1 });
  assert.deepEqual(splitHms(0), { hours: 0, minutes: 0, seconds: 0 });
});

// --- period windows ---------------------------------------------------------

test('week window honours company weekStartsOn (Mon) and timezone, not a rolling 7 days', () => {
  const now = new Date('2025-03-12T15:00:00Z'); // Wed
  const w = companyPeriodWindow(now, 'America/New_York', 1, 'week');
  assert.equal(w.start.toISOString(), '2025-03-10T04:00:00.000Z'); // Mon 00:00 EDT
  assert.equal(w.end.toISOString(), '2025-03-17T04:00:00.000Z');   // next Mon 00:00 EDT
});

test('bi-week is the current fortnight (this week + previous week), DST-correct', () => {
  const now = new Date('2025-03-12T15:00:00Z');
  const w = companyPeriodWindow(now, 'America/New_York', 1, 'biweek');
  // Start is EST (UTC-5, before Mar 9 DST change), end is EDT (UTC-4) — offsets differ.
  assert.equal(w.start.toISOString(), '2025-03-03T05:00:00.000Z');
  assert.equal(w.end.toISOString(), '2025-03-17T04:00:00.000Z');
});

test('month/3months/6months/year are calendar-month aligned ending with the current month', () => {
  const now = new Date('2025-03-12T15:00:00Z');
  const tz = 'America/New_York';
  assert.equal(companyPeriodWindow(now, tz, 1, 'month').start.toISOString(), '2025-03-01T05:00:00.000Z');
  assert.equal(companyPeriodWindow(now, tz, 1, 'month').end.toISOString(), '2025-04-01T04:00:00.000Z');
  assert.equal(companyPeriodWindow(now, tz, 1, '3months').start.toISOString(), '2025-01-01T05:00:00.000Z');
  assert.equal(companyPeriodWindow(now, tz, 1, '6months').start.toISOString(), '2024-10-01T04:00:00.000Z');
  assert.equal(companyPeriodWindow(now, tz, 1, 'year').start.toISOString(), '2024-04-01T04:00:00.000Z');
  assert.equal(companyPeriodWindow(now, tz, 1, 'year').end.toISOString(), '2025-04-01T04:00:00.000Z');
});

test('an unknown period falls back to week', () => {
  const now = new Date('2025-03-12T15:00:00Z');
  const w = companyPeriodWindow(now, 'America/New_York', 1, 'nonsense');
  assert.equal(w.period, 'week');
});

test('all six documented periods resolve to a valid half-open window', () => {
  const now = new Date('2025-03-12T15:00:00Z');
  for (const p of MY_HOURS_PERIODS) {
    const w = companyPeriodWindow(now, 'America/New_York', 0, p);
    assert.ok(w.start < w.end, `${p} start<end`);
  }
});

// --- service read path ------------------------------------------------------

test('getMyHours: exact seconds, default period week, scoped to THIS bcba + company week', async () => {
  const { svc, calls } = makeService({
    staffing: { weekStartsOn: 1 },
    sum: { seconds: 42 * 3600 + 17 * 60 + 38, sessions: 9 },
  });
  const r = await svc.getMyHours({ tenantId: 't1', bcbaStaffProfileId: 'bcba-1' });
  assert.equal(r.period, 'week');
  assert.equal(r.totalSeconds, 42 * 3600 + 17 * 60 + 38);
  assert.equal(r.hours, 42);
  assert.equal(r.minutes, 17);
  assert.equal(r.seconds, 38);
  assert.equal(r.text, '42h 17m 38s');
  assert.equal(r.sessionCount, 9);
  // own-scope + company (Mon-start ET) week
  assert.equal(calls.sum[0].staffProfileId, 'bcba-1');
  assert.equal(calls.sum[0].from.toISOString(), '2025-03-10T04:00:00.000Z');
  assert.equal(calls.sum[0].to.toISOString(), '2025-03-17T04:00:00.000Z');
});

test('getMyHours: response is worked-time only — no pay/rate/amount/currency fields', async () => {
  const { svc } = makeService({ sum: { seconds: 3600, sessions: 1 } });
  const r = await svc.getMyHours({ tenantId: 't1', bcbaStaffProfileId: 'bcba-1', period: 'month' });
  for (const k of ['amount', 'hourlyRateSnapshot', 'rate', 'pay', 'currency', 'earnings', 'salary']) {
    assert.ok(!(k in r), `My Hours must not expose ${k}`);
  }
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes('$'), 'no dollar values');
});

test('getMyHours: a different period changes the queried window', async () => {
  const { svc, calls } = makeService({ sum: { seconds: 0, sessions: 0 } });
  await svc.getMyHours({ tenantId: 't1', bcbaStaffProfileId: 'bcba-1', period: 'year' });
  assert.equal(calls.sum[0].from.toISOString(), '2024-04-01T04:00:00.000Z');
  assert.equal(calls.sum[0].to.toISOString(), '2025-04-01T04:00:00.000Z');
});

test('getMyHours requires the acting BCBA (never trusts an arbitrary staffProfileId)', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.getMyHours({ tenantId: 't1', bcbaStaffProfileId: null }));
});
