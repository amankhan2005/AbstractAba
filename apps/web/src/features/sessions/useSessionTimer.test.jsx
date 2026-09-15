import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useSessionTimer, formatElapsed, formatWorkedTime } from './useSessionTimer.js';

/**
 * ---------------------------------------------------------------------------
 * THE TIMER IS NOT ALLOWED TO BE A FRONTEND CLOCK.
 *
 * These tests pin the two properties that separate a real timer from a fake
 * one:
 *
 *   1. elapsed time is (now − the PERSISTED anchor), so a component that mounts
 *      27 minutes into a work period shows 0:27 immediately, not 0:00. This is
 *      what makes a refresh and a navigation keep the correct time: neither
 *      carries any browser state, and both simply mount afresh.
 *
 *   2. the anchor is the CURRENT WORK PERIOD's start, not the session's. A
 *      timer anchored on the session start counts breaks as time on the clock:
 *      after 09:00-09:30 and a break until 11:00, ten minutes into the restart
 *      it read 2:10.
 *
 * The system clock is faked so elapsed time is exact rather than timing-
 * dependent.
 * ---------------------------------------------------------------------------
 */

let host; let root;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = undefined; host = undefined;
  vi.useRealTimers();
});

/** Mount a probe that renders whatever the hook returns. */
function renderTimer(anchor, running = true) {
  function Probe() {
    const { text } = useSessionTimer(anchor, running);
    return <span data-testid="t">{text}</span>;
  }
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<Probe />));
  return () => host.querySelector('[data-testid="t"]').textContent;
}

describe('useSessionTimer — anchored on persisted session time', () => {
  it('shows real elapsed time on the very first render, not 0:00', () => {
    // The clinician started 27 minutes ago; this mount is a fresh page load.
    vi.setSystemTime(new Date('2026-09-12T09:42:00Z'));
    const read = renderTimer('2026-09-12T09:15:00Z');
    expect(read()).toBe('27:00');
  });

  it('a refresh mid-session reconstructs the same time — it does not reset', () => {
    vi.setSystemTime(new Date('2026-09-12T09:42:00Z'));
    const first = renderTimer('2026-09-12T09:15:00Z');
    const before = first();

    // "Refresh": unmount everything and mount again from scratch, exactly as a
    // reload does. Nothing is carried across.
    act(() => root.unmount()); host.remove(); root = undefined; host = undefined;
    const second = renderTimer('2026-09-12T09:15:00Z');

    expect(second()).toBe(before);
    expect(second()).toBe('27:00');
  });

  it('keeps counting as wall-clock time advances', () => {
    vi.setSystemTime(new Date('2026-09-12T09:15:00Z'));
    const read = renderTimer('2026-09-12T09:15:00Z');
    expect(read()).toBe('0:00');

    act(() => { vi.advanceTimersByTime(60_000 * 37); });
    expect(read()).toBe('37:00');
  });

  it('does not drift: each tick recomputes from the anchor', () => {
    // A counter that increments would accumulate error when timers are delayed;
    // recomputing from a fixed anchor cannot.
    vi.setSystemTime(new Date('2026-09-12T09:00:00Z'));
    const read = renderTimer('2026-09-12T09:00:00Z');
    for (let i = 0; i < 30; i += 1) act(() => { vi.advanceTimersByTime(2_000); });
    expect(read()).toBe('1:00');
  });

  it('reports NOT ready when there is no anchor — never a false 0:00', () => {
    // A literal 0:00 while the active session is still loading is
    // indistinguishable from a session that just started, and reads to the
    // clinician as "my timer reset". The hook withholds text instead.
    vi.setSystemTime(new Date('2026-09-12T09:42:00Z'));
    let snapshot;
    function Probe() { snapshot = useSessionTimer(null, false); return null; }
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root.render(<Probe />));

    expect(snapshot.ready).toBe(false);
    expect(snapshot.text).toBeNull();
  });

  it('reports ready as soon as the persisted anchor is known', () => {
    vi.setSystemTime(new Date('2026-09-12T09:42:00Z'));
    let snapshot;
    function Probe() { snapshot = useSessionTimer('2026-09-12T09:15:00Z', true); return null; }
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root.render(<Probe />));

    expect(snapshot.ready).toBe(true);
    expect(snapshot.text).toBe('27:00');
  });

  it('freezes rather than counting when the session is stopped', () => {
    vi.setSystemTime(new Date('2026-09-12T09:45:00Z'));
    const read = renderTimer('2026-09-12T09:15:00Z', false);
    const frozen = read();
    act(() => { vi.advanceTimersByTime(60_000 * 10); });
    expect(read()).toBe(frozen);
  });

  it('counts the CURRENT work period, never the break before it', () => {
    // Session started 09:00. First period 09:00-09:30, break, restart at 11:00.
    // At 11:10 the timer must read 0:10.
    vi.setSystemTime(new Date('2026-09-12T11:10:00Z'));

    const correct = renderTimer('2026-09-12T11:00:00Z'); // activePeriodStartedAt
    expect(correct()).toBe('10:00');

    act(() => root.unmount()); host.remove(); root = undefined; host = undefined;

    // Anchoring on the SESSION start is the regression — it counts the break.
    const wrong = renderTimer('2026-09-12T09:00:00Z');
    expect(wrong()).toBe('2:10:00');
  });
});

describe('formatElapsed — a live clock', () => {
  it('renders M:SS under an hour, so the display visibly ticks', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(3_000)).toBe('0:03');
    expect(formatElapsed(47_000)).toBe('0:47');
    expect(formatElapsed(60_000)).toBe('1:00');          // one minute
    expect(formatElapsed(60_000 * 2)).toBe('2:00');
    expect(formatElapsed(60_000 * 59 + 30_000)).toBe('59:30');
  });

  it('rolls into H:MM:SS at an hour', () => {
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(3_600_000 + 60_000 * 5)).toBe('1:05:00');
    expect(formatElapsed(60_000 * 150)).toBe('2:30:00');
  });

  it('never renders a negative duration', () => {
    expect(formatElapsed(-5_000)).toBe('0:00');
  });
});

describe('formatWorkedTime — for lists and records, not a clock', () => {
  it('renders hours and minutes instead of a raw minute count', () => {
    expect(formatWorkedTime(150)).toBe('2h 30m');
    expect(formatWorkedTime(30)).toBe('30m');
    expect(formatWorkedTime(45)).toBe('45m');
    expect(formatWorkedTime(65)).toBe('1h 05m');
    expect(formatWorkedTime(495)).toBe('8h 15m');
    expect(formatWorkedTime(120)).toBe('2h');
  });

  it('is safe for missing or nonsense input', () => {
    expect(formatWorkedTime(0)).toBe('0m');
    expect(formatWorkedTime(null)).toBe('0m');
    expect(formatWorkedTime(undefined)).toBe('0m');
    expect(formatWorkedTime(-10)).toBe('0m');
  });
});

describe('network interruption', () => {
  it('keeps counting from the persisted anchor while the network is down', () => {
    // The anchor is already known, so a failed refetch changes nothing: the
    // browser keeps deriving elapsed time locally from the SERVER's start time.
    // It must not reset to 0:00 and must not invent time.
    vi.setSystemTime(new Date('2026-09-12T09:15:00Z'));
    const read = renderTimer('2026-09-12T09:15:00Z');

    act(() => { vi.advanceTimersByTime(60_000 * 20); });   // 20 minutes offline
    expect(read()).toBe('20:00');

    // Reconnect: the server returns the SAME anchor, so the display is stable.
    act(() => root.unmount()); host.remove(); root = undefined; host = undefined;
    const afterReconnect = renderTimer('2026-09-12T09:15:00Z');
    expect(afterReconnect()).toBe('20:00');
  });

  it('withholds the timer entirely if the anchor was never obtained', () => {
    // If the very first load failed, there is no authoritative start time. The
    // hook reports not-ready rather than showing 0:00, which would read as a
    // running session that just began.
    vi.setSystemTime(new Date('2026-09-12T09:42:00Z'));
    let snapshot;
    function Probe() { snapshot = useSessionTimer(undefined, true); return null; }
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root.render(<Probe />));

    expect(snapshot.ready).toBe(false);
    expect(snapshot.text).toBeNull();
    expect(snapshot.elapsedMs).toBe(0);
  });
});

describe('an unusable anchor must never render as 0:00', () => {
  /**
   * THE REGRESSION. `new Date(x).getTime()` is NaN for a value that is present
   * but unparseable, and `NaN != null` is true — so the readiness test passed,
   * and formatElapsed's numeric coercion turned NaN into 0. The result was a
   * permanently frozen "0:00" sitting next to a correctly-rendered session
   * start time: a data problem disguised as a plausible number.
   */
  const unusable = [
    ['an object that survived serialization', {}],
    ['an already-formatted clock string', '7:08 AM'],
    ['a literal Invalid Date string', 'Invalid Date'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
  ];

  for (const [label, value] of unusable) {
    it(`reports not-ready for ${label}`, () => {
      vi.setSystemTime(new Date('2026-09-12T09:42:00Z'));
      let snapshot;
      function Probe() { snapshot = useSessionTimer(value, true); return null; }
      host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
      act(() => root.render(<Probe />));

      expect(snapshot.ready, `${label} was treated as a usable anchor`).toBe(false);
      expect(snapshot.text, `${label} rendered a timer`).toBeNull();
      // The specific failure: it must not paint a frozen zero.
      expect(snapshot.text).not.toBe('0:00');
    });
  }

  it('a stuck anchor does not silently become 0:00 as time passes', () => {
    vi.setSystemTime(new Date('2026-09-12T09:42:00Z'));
    const read = renderTimer('7:08 AM');
    expect(read()).toBe('');          // nothing rendered, not a zero
    act(() => { vi.advanceTimersByTime(60_000 * 30); });
    expect(read()).toBe('');
  });

  it('still counts normally once a real ISO anchor arrives', () => {
    vi.setSystemTime(new Date('2026-09-12T07:32:00Z'));
    const read = renderTimer('2026-09-12T07:08:00Z');
    expect(read()).toBe('24:00');
  });
});
