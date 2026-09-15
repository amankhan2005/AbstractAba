import { describe, it, expect, vi } from 'vitest';
import {
  monthGrid, gridRange, shiftMonth, monthLabel, longDateLabel, fetchAppointmentRange, bucketByDay,
  scheduledTimeLabel, dateSpanLabel, upsertInRange, matchesFilters,
} from './calendarModel.js';
import { zonedWallTimeToUtc } from '@/lib/businessDate';

const TZ = 'America/New_York';
const mid = (y, m, d) => zonedWallTimeToUtc(y, m, d, 0, 0, 0, TZ).toISOString();

describe('calendar model (organization business dates)', () => {
  it('builds a 6-week Sunday-first grid from civil dates', () => {
    const grid = monthGrid({ year: 2026, month: 9 });
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe('2026-08-30');
    expect(grid[2]).toBe('2026-09-01');
    expect(grid[41]).toBe('2026-10-10');
    expect(monthLabel({ year: 2026, month: 9 })).toBe('September 2026');
    expect(longDateLabel('2026-09-14')).toBe('Monday, 09/14/2026');
  });

  it('month navigation rolls over years', () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });

  it('the loaded range is anchored to org-timezone midnights, with a lead for multi-day appointments', () => {
    const r = gridRange(monthGrid({ year: 2026, month: 9 }), TZ);
    expect(r.from).toBe(mid(2026, 7, 30)); // 08/30 − 31 days, NY midnight
    expect(r.to).toBe(new Date(Date.parse(mid(2026, 10, 11)) - 1).toISOString());
  });

  it('loads a whole range through the list endpoint page by page (limit 100, cursor), never per appointment', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ items: [{ id: 'a' }, { id: 'b' }], meta: { nextCursor: 'c1' } })
      .mockResolvedValueOnce({ items: [{ id: 'c' }], meta: { nextCursor: null } });
    const res = await fetchAppointmentRange(list, { from: 'F', to: 'T', clientId: 'x' });
    expect(res).toEqual({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], complete: true });
    expect(list.mock.calls).toEqual([[{ from: 'F', to: 'T', clientId: 'x', limit: 100 }], [{ from: 'F', to: 'T', clientId: 'x', limit: 100, cursor: 'c1' }]]);
    const endless = vi.fn().mockResolvedValue({ items: [{ id: 'z' }], meta: { nextCursor: 'again' } });
    expect((await fetchAppointmentRange(endless, {}, { maxPages: 3 })).complete).toBe(false);
    expect(endless).toHaveBeenCalledTimes(3);
  });

  it('buckets a multi-day date-only appointment on every covered business date (end exclusive)', () => {
    const map = bucketByDay([{ id: 'm', timeSet: false, startAt: mid(2026, 9, 21), endAt: mid(2026, 9, 24) }], TZ);
    expect([...map.keys()]).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
  });

  it('a date-only appointment has no clock time (no fabricated midnight); a timed one shows its org-time range', () => {
    const dateOnly = { timeSet: false, startAt: mid(2026, 9, 14), endAt: mid(2026, 9, 15) };
    expect(scheduledTimeLabel(dateOnly, TZ)).toBe('');
    expect(dateSpanLabel(dateOnly, TZ)).toBe('');
    const timed = { timeSet: true, startAt: zonedWallTimeToUtc(2026, 9, 14, 9, 0, 0, TZ), endAt: zonedWallTimeToUtc(2026, 9, 14, 10, 30, 0, TZ) };
    expect(scheduledTimeLabel(timed, TZ)).toBe('9:00 AM – 10:30 AM');
    expect(dateSpanLabel({ timeSet: false, startAt: mid(2026, 9, 21), endAt: mid(2026, 9, 24) }, TZ)).toBe('09/21/2026 – 09/23/2026');
  });

  it('cache upsert: inserts in range and matching filters, replaces by id, removes when moved out', () => {
    const params = { from: mid(2026, 9, 1), to: mid(2026, 10, 1), clientId: 'c1' };
    const data = { items: [{ id: 'a', clientId: 'c1', startAt: mid(2026, 9, 3), status: 'SCHEDULED' }], complete: true };
    const added = upsertInRange(data, { id: 'b', clientId: 'c1', startAt: mid(2026, 9, 15), status: 'SCHEDULED' }, params);
    expect(added.items.map((x) => x.id)).toEqual(['a', 'b']);
    expect(upsertInRange(data, { id: 'z', clientId: 'other', startAt: mid(2026, 9, 15) }, params)).toBe(data);
    const moved = upsertInRange(added, { id: 'a', clientId: 'c1', startAt: mid(2026, 11, 3) }, params);
    expect(moved.items.map((x) => x.id)).toEqual(['b']);
    expect(matchesFilters({ status: 'CANCELLED' }, { status: 'SCHEDULED' })).toBe(false);
  });
});
