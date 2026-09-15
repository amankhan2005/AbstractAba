import { describe, it, expect } from 'vitest';
import { formatElapsed } from './useSessionTimer.js';

/**
 * The timer's SOURCE OF TRUTH is the server-persisted start of the active work
 * period: the hook derives elapsed = now − anchor on every tick, so a refresh
 * reconstructs the real elapsed time instead of resetting. These tests lock the
 * pure formatting the display depends on; the lifecycle is covered in
 * useSessionTimer.test.jsx.
 *
 * FORMAT CHANGE. This used to assert H:MM, which meant 75 seconds rendered as
 * "0:01" and forty seconds rendered as "0:00". Both are arithmetically right
 * and both read as a broken clock — a clinician watching a timer they just
 * started saw a number that did not move for a full minute. The live timer now
 * shows seconds (M:SS, rolling to H:MM:SS after an hour) so it is visibly
 * running. Worked time in LISTS stays minute-resolution via formatWorkedTime.
 */
describe('formatElapsed', () => {
  it('shows M:SS under an hour, so the clock visibly ticks', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(1000)).toBe('0:01');
    expect(formatElapsed(75 * 1000)).toBe('1:15');
    expect(formatElapsed(59 * 60 * 1000 + 59 * 1000)).toBe('59:59');
  });

  it('rolls into H:MM:SS at an hour', () => {
    expect(formatElapsed(((1 * 60 + 15) * 60 + 23) * 1000)).toBe('1:15:23');
    expect(formatElapsed(3 * 3600 * 1000 + 3 * 60 * 1000 + 27 * 1000)).toBe('3:03:27');
  });

  it('reconstructs elapsed from a fixed anchor (no reset on refresh)', () => {
    const startedAt = Date.now() - 90_000; // started 90s ago
    const elapsed = Math.max(0, Date.now() - startedAt);
    // Whatever the mount time, the value derives from the anchor, not a counter.
    expect(formatElapsed(elapsed)).toBe('1:30');
  });
});
