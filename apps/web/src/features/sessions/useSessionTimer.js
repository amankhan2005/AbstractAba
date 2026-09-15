import { useEffect, useRef, useState } from 'react';

/**
 * A running session timer whose SOURCE OF TRUTH is the server-persisted start
 * of the CURRENTLY RUNNING WORK PERIOD, never the browser clock.
 *
 * Callers must pass `card.activePeriodStartedAt`, not `card.startedAt`.
 * `startedAt` is the start of the whole logical session and never moves, so a
 * timer anchored on it counts every break as elapsed time: a clinician who
 * worked 09:00-09:30, stopped until 11:00 and restarted saw 2:10 ten minutes
 * into the second period. `activePeriodStartedAt` is the open work period's own
 * start, and it is persisted, so a refresh reconstructs it exactly.
 *
 * The hook derives elapsed time as (now - anchor) on every tick, so:
 *   - a page refresh reconstructs the correct elapsed time (it does not reset);
 *   - navigating between the Session and Child dashboards keeps counting;
 *   - clock skew on the device cannot drift the displayed total, because each
 *     tick recomputes from the fixed anchor rather than incrementing a counter.
 *
 * @param {string|Date|null} startedAt  persisted start of the ACTIVE work period;
 *                                      null → nothing running, no timer
 * @param {boolean} running             whether to tick (false freezes the display)
 * @returns {{ elapsedMs:number, text:string }}
 */
export function useSessionTimer(startedAt, running = true) {
  // `text` is null — NOT '0:00' — whenever there is no USABLE anchor. A literal
  // 0:00 is indistinguishable from a session that genuinely just started, and
  // it is the single most misleading thing this component can render: the
  // clinician sees their timer stuck at zero on a session they know is running.
  //
  // "Usable" means it actually PARSES. An anchor that is present but
  // unparseable — a value that survived serialization as an object, an
  // already-formatted "7:08 AM" string, an Invalid Date — produced NaN, and
  // NaN != null, so the old readiness test passed it through. formatElapsed
  // then coerced NaN to 0 and painted a permanent, frozen, entirely plausible
  // 0:00 while the session header happily showed the real start time beside it.
  // That is a data problem being disguised as a number, so it is now caught
  // here: an unusable anchor is NOT ready, and the caller shows a loading or
  // unavailable state instead of inventing an elapsed time.
  const parsed = startedAt == null || startedAt === '' ? NaN : new Date(startedAt).getTime();
  const anchor = Number.isFinite(parsed) ? parsed : null;
  const [elapsedMs, setElapsedMs] = useState(() => (anchor ? Math.max(0, Date.now() - anchor) : 0));
  const raf = useRef(null);

  useEffect(() => {
    if (!anchor || !running) {
      if (anchor && !running) setElapsedMs(Math.max(0, Date.now() - anchor));
      return undefined;
    }
    let active = true;
    const tick = () => {
      if (!active) return;
      setElapsedMs(Math.max(0, Date.now() - anchor));
      raf.current = setTimeout(tick, 1000);
    };
    tick();
    return () => {
      active = false;
      if (raf.current) clearTimeout(raf.current);
    };
  }, [anchor, running]);

  const ready = anchor != null;
  return {
    elapsedMs,
    /** Formatted elapsed time, or null when no authoritative anchor is known. */
    text: ready ? formatElapsed(elapsedMs) : null,
    /** True once the persisted start time is known and the display is truthful. */
    ready,
  };
}

/**
 * Elapsed time as a LIVE CLOCK.
 *
 *   under an hour   M:SS    0:03   0:47   1:00   2:30   59:30
 *   an hour or more H:MM:SS 1:05:00   2:30:15
 *
 * WHY THE SECONDS MATTER. This used to render H:MM, which meant a session that
 * had been running for forty seconds displayed "0:00", and after a full minute
 * displayed "0:01". Both are arithmetically correct and both look broken: a
 * clinician watching a timer they just started sees a number that does not move
 * for sixty seconds, and then sees "0:01" where they expected one minute. The
 * reported "timer is stuck at 0:00 even though the session started at 7:49 AM"
 * is that: a minute-resolution display on a screen the user reads as a clock.
 *
 * Seconds also make the timer self-evidently ALIVE, which is the whole point of
 * showing it — a number that visibly ticks is the difference between "this is
 * running" and "is this broken?".
 *
 * Clamped at zero: a device whose clock sits behind the server would otherwise
 * render a negative duration on the first paint after starting a session. The
 * hook already clamps its own value, but this is exported and used directly
 * elsewhere, so it defends itself.
 */
export function formatElapsed(ms) {
  let secs = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(secs / 3600); secs -= h * 3600;
  const m = Math.floor(secs / 60); secs -= m * 60;
  const ss = String(secs).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/**
 * Worked time for LISTS and records: "2h 30m", "45m", "1h 05m".
 *
 * Distinct from the live timer on purpose. A list is read, not watched, so
 * seconds are noise there; and "150 minutes" is a number a reader has to do
 * arithmetic on. The backend keeps storing authoritative whole minutes — this
 * only changes how they are presented.
 */
export function formatWorkedTime(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
