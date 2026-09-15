import { useEffect, useState } from 'react';
import { nextStartBoundary } from '@/lib/appointment';

// setTimeout's ceiling (~24.8 days); longer waits are re-armed.
const MAX_DELAY_MS = 2 ** 31 - 1;
// How often the wall clock is compared with the next boundary. A timer does not
// run while the machine sleeps (or runs late in a background tab), so the
// boundary timeout alone can leave a screen judging cards by yesterday's clock.
const WATCHDOG_MS = 30 * 1000;

/**
 * The current time, re-read EXACTLY when any of these cards' 24-hour start
 * windows opens or closes. Screens that decide Start eligibility (Start
 * Session panel, appointment cards, sections) render against this `now`, so
 * an appointment disappears from Start Session the moment its window closes
 * and the next one appears the moment its window opens — no refetch, no
 * reliance on the page being reloaded. The server still refuses a start
 * outside the window on its own clock.
 *
 * `now` is also re-read when the page becomes visible / regains focus, and a
 * light watchdog re-reads it whenever the wall clock has passed a boundary the
 * timeout missed (laptop asleep over midnight). The watchdog only sets state
 * when a boundary was actually crossed, so it causes no extra renders.
 */
export function useStartWindowClock(cards, timeZone) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const boundary = nextStartBoundary(cards ?? [], timeZone, now);
    if (!boundary) return undefined;
    const crossed = () => Date.now() >= boundary.getTime();
    // The boundary may already be behind the real clock (stale `now`).
    if (crossed()) { setNow(new Date()); return undefined; }
    const delay = Math.min(Math.max(boundary.getTime() - Date.now() + 25, 0), MAX_DELAY_MS);
    const timeout = setTimeout(() => setNow(new Date()), delay);
    const watchdog = setInterval(() => { if (crossed()) setNow(new Date()); }, WATCHDOG_MS);
    return () => { clearTimeout(timeout); clearInterval(watchdog); };
  }, [cards, timeZone, now]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setNow(new Date());
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return now;
}

export default useStartWindowClock;
