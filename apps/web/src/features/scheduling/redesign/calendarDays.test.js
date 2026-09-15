import { describe, it, expect } from 'vitest';
import { coveredDays } from './calendarDays.js';

/**
 * Calendar day marking is a BUSINESS-date question, so every case here is run
 * in more than one organization timezone. The bug these replace was invisible
 * in a single zone: the old implementation bucketed by the BROWSER's timezone,
 * so the same appointment landed on a different square depending on who was
 * looking at it (09/13 from an IST browser, 09/11 from a US one).
 *
 * `endAt` is the EXCLUSIVE upper bound, matching the API: a date-only
 * appointment ends at org midnight of the day AFTER its last scheduled day.
 */

const NY = 'America/New_York';
const IST = 'Asia/Kolkata';

describe('coveredDays — business-date calendar marking', () => {
  it('marks a single business day for a date-only appointment, in any org zone', () => {
    // 09/12 in New York: org midnight 09/12 → exclusive org midnight 09/13.
    expect(coveredDays('2026-09-12T04:00:00Z', '2026-09-13T04:00:00Z', NY)).toEqual(['2026-09-12']);
    // The same business day in Kolkata is a different pair of instants.
    expect(coveredDays('2026-09-11T18:30:00Z', '2026-09-12T18:30:00Z', IST)).toEqual(['2026-09-12']);
  });

  it('does NOT mark the day after — the exclusive end bound is respected', () => {
    const days = coveredDays('2026-09-12T04:00:00Z', '2026-09-13T04:00:00Z', NY);
    expect(days).not.toContain('2026-09-13');
  });

  it('marks every day of a multi-day appointment, end date inclusive', () => {
    expect(coveredDays('2026-09-12T04:00:00Z', '2026-09-15T04:00:00Z', NY))
      .toEqual(['2026-09-12', '2026-09-13', '2026-09-14']);
    expect(coveredDays('2026-09-11T18:30:00Z', '2026-09-14T18:30:00Z', IST))
      .toEqual(['2026-09-12', '2026-09-13', '2026-09-14']);
  });

  it('keeps a US-evening appointment on its own business day, not the next', () => {
    // 8pm–10pm New York is 00:00–02:00 UTC the following day.
    expect(coveredDays('2026-09-13T00:00:00Z', '2026-09-13T02:00:00Z', NY)).toEqual(['2026-09-12']);
  });

  it('keeps an IST-evening appointment on its own business day', () => {
    // 7pm–9pm Kolkata. Stored as UTC wall-clock, this used to render on 09/13.
    expect(coveredDays('2026-09-12T13:30:00Z', '2026-09-12T15:30:00Z', IST)).toEqual(['2026-09-12']);
  });

  it('marks every day across a month boundary', () => {
    expect(coveredDays('2026-09-29T04:00:00Z', '2026-10-03T04:00:00Z', NY))
      .toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('a month-long appointment marks all of its days', () => {
    const days = coveredDays('2026-09-01T04:00:00Z', '2026-10-01T04:00:00Z', NY);
    expect(days.length).toBe(30);
    expect(days[0]).toBe('2026-09-01');
    expect(days[days.length - 1]).toBe('2026-09-30');
    expect(days).toContain('2026-09-15');
  });

  it('falls back to the start day when there is no end', () => {
    expect(coveredDays('2026-09-12T14:00:00Z', null, NY)).toEqual(['2026-09-12']);
  });

  it('is safe for nullish/invalid input', () => {
    expect(coveredDays(null, null, NY)).toEqual([]);
    expect(coveredDays('nope', 'nope', NY)).toEqual([]);
  });

  it('returns nothing for an inverted range rather than looping', () => {
    expect(coveredDays('2026-09-10T00:00:00Z', '2026-09-01T00:00:00Z', NY)).toEqual([]);
  });

  it('crosses a DST boundary without dropping or duplicating a day', () => {
    // US DST ends 11/01/2026. 10/31 → 11/02 inclusive is three days, even though
    // one of them is 25 hours long.
    expect(coveredDays('2026-10-31T04:00:00Z', '2026-11-03T05:00:00Z', NY))
      .toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });
});
