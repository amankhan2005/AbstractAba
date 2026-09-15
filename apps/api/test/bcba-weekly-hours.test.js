import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  companyWeekWindow, zonedMidnightToUtc, summarizeWeekly, humanHm,
} from '../src/modules/bcba-session/weeklyHours.js';
import { BcbaSessionService } from '../src/modules/bcba-session/bcbaSession.service.js';

/** A service wired with fake ports for the weekly-hours read path only. */
function makeService({ timezone = 'America/New_York', staffing = {}, sum = { minutes: 0, sessions: 0 } } = {}) {
  const calls = { sum: [] };
  const svc = new BcbaSessionService({
    organizations: { getById: async () => ({ state: 'ACTIVE', timezone }) },
    settings: { getStaffing: async () => staffing },
    timeRecords: {
      sumWorkedMinutes: async (tenantId, opts) => { calls.sum.push({ tenantId, ...opts }); return sum; },
    },
    phi: { seal: (v) => v, open: (v) => v },
    clock: { now: () => new Date('2026-09-04T21:50:12.000Z') }, // Fri 17:50 EDT
  });
  return { svc, calls };
}

test('getWeeklyHours: configured 30h target, 3h worked → 27h remaining, window is company week', async () => {
  const { svc, calls } = makeService({
    staffing: { weeklyHoursTarget: 30, weekStartsOn: 0 },
    sum: { minutes: 180, sessions: 3 },
  });
  const r = await svc.getWeeklyHours({ tenantId: 't1', bcbaStaffProfileId: 'bcba-1' });
  assert.equal(r.configured, true);
  assert.equal(r.completedText, '3h 00m');
  assert.equal(r.targetText, '30h 00m');
  assert.equal(r.remainingText, '27h 00m');
  assert.equal(r.sessionCount, 3);
  // Aggregate was scoped to THIS bcba and the strict Monday → Sunday week in
  // the org timezone (ET) — even though the company setting says Sunday.
  assert.equal(calls.sum[0].staffProfileId, 'bcba-1');
  assert.equal(calls.sum[0].from.toISOString(), '2026-08-31T04:00:00.000Z'); // Mon 08/31 00:00 EDT
  assert.equal(calls.sum[0].to.toISOString(), '2026-09-07T04:00:00.000Z');   // Mon 09/07 00:00 EDT (exclusive)
  assert.equal(r.weekStartsOn, 1);
});

test('getWeeklyHours: no configured target → not shown, no fabricated numbers', async () => {
  const { svc } = makeService({ staffing: { weeklyHoursTarget: 0 }, sum: { minutes: 240, sessions: 4 } });
  const r = await svc.getWeeklyHours({ tenantId: 't1', bcbaStaffProfileId: 'bcba-1' });
  assert.equal(r.configured, false);
  assert.equal(r.targetText, null);
  assert.equal(r.completedText, '4h 00m'); // completed is still truthful
});

test('getWeeklyHours requires the acting BCBA (never trusts the body)', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.getWeeklyHours({ tenantId: 't1', bcbaStaffProfileId: null }));
});

/**
 * DB-free tests for the weekly-hours math (spec §K–§N). The company week is a
 * timezone-aware, company-week-start-anchored interval — NOT a rolling 7-day
 * window — and progress is derived from actual worked minutes.
 */

test('zonedMidnightToUtc resolves local midnight across DST offsets', () => {
  // EDT (UTC-4) in September.
  assert.equal(
    zonedMidnightToUtc(2026, 8, 30, 'America/New_York').toISOString(),
    '2026-08-30T04:00:00.000Z',
  );
  // EST (UTC-5) in January — proves the offset is measured at the target date.
  assert.equal(
    zonedMidnightToUtc(2026, 1, 4, 'America/New_York').toISOString(),
    '2026-01-04T05:00:00.000Z',
  );
  // UTC is its own midnight.
  assert.equal(
    zonedMidnightToUtc(2026, 9, 6, 'UTC').toISOString(),
    '2026-09-06T00:00:00.000Z',
  );
});

test('companyWeekWindow: Sunday-start week in New York, midweek instant', () => {
  // Fri 2026-09-04 17:50 EDT (= 21:50Z). Week (Sun-start) is 08-30 .. 09-06 EDT.
  const now = new Date('2026-09-04T21:50:12.000Z');
  const w = companyWeekWindow(now, 'America/New_York', 0);
  assert.equal(w.start.toISOString(), '2026-08-30T04:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-09-06T04:00:00.000Z');
  assert.ok(now >= w.start && now < w.end, 'now falls inside its own week');
});

test('companyWeekWindow: Monday-start week (UTC) puts Sunday in the PREVIOUS week', () => {
  const friday = companyWeekWindow(new Date('2026-09-04T12:00:00Z'), 'UTC', 1);
  assert.equal(friday.start.toISOString(), '2026-08-31T00:00:00.000Z');
  assert.equal(friday.end.toISOString(), '2026-09-07T00:00:00.000Z');

  // Sunday 2026-09-06 belongs to the week that STARTED Monday 08-31.
  const sunday = companyWeekWindow(new Date('2026-09-06T12:00:00Z'), 'UTC', 1);
  assert.equal(sunday.start.toISOString(), '2026-08-31T00:00:00.000Z');
});

test('companyWeekWindow rolls month/year boundaries', () => {
  // Thu 2026-01-01 (UTC). Sunday-start week began Sun 2025-12-28.
  const w = companyWeekWindow(new Date('2026-01-01T09:00:00Z'), 'UTC', 0);
  assert.equal(w.start.toISOString(), '2025-12-28T00:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-01-04T00:00:00.000Z');
});

test('summarizeWeekly: unconfigured target is not shown', () => {
  for (const t of [null, undefined, 0]) {
    const s = summarizeWeekly({ targetHours: t, completedMinutes: 120 });
    assert.equal(s.configured, false);
    assert.equal(s.targetText, null);
    assert.equal(s.remainingText, null);
  }
});

test('summarizeWeekly: 30h target, 1h done → 29h remaining (§L)', () => {
  const s = summarizeWeekly({ targetHours: 30, completedMinutes: 60 });
  assert.equal(s.configured, true);
  assert.equal(s.completedText, '1h 00m');
  assert.equal(s.targetText, '30h 00m');
  assert.equal(s.remainingText, '29h 00m');
  assert.equal(s.percent, 3); // round(60/1800*100)
});

test('summarizeWeekly: aggregation and overtime clamp', () => {
  // 18h done against 30h → 12h remaining, 60%.
  const mid = summarizeWeekly({ targetHours: 30, completedMinutes: 18 * 60 });
  assert.equal(mid.remainingText, '12h 00m');
  assert.equal(mid.percent, 60);
  // Over target: remaining floors at 0, percent clamps at 100, overtime flagged.
  const over = summarizeWeekly({ targetHours: 30, completedMinutes: 32 * 60 });
  assert.equal(over.remainingMinutes, 0);
  assert.equal(over.percent, 100);
  assert.equal(over.overtime, true);
});

test('humanHm formats whole minutes with zero-padded minutes', () => {
  assert.equal(humanHm(0), '0h 00m');
  assert.equal(humanHm(65), '1h 05m');
  assert.equal(humanHm(600), '10h 00m');
});
