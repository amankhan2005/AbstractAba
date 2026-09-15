import { useEffect, useState } from 'react';
import { civilDateString, zonedWallTimeToUtc } from './businessDate.js';

// How often the wall clock is re-checked. Timers pause while the machine
// sleeps, so the midnight timeout alone can miss the change of day.
const WATCHDOG_MS = 30 * 1000;

/** The instant the business date after `date` ('YYYY-MM-DD') begins in `timeZone`. */
export function nextBusinessMidnight(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return zonedWallTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, timeZone);
}

/**
 * The CURRENT business date ('YYYY-MM-DD') in the organization timezone, kept
 * current while a screen stays open: it changes at org midnight, when the page
 * becomes visible again, and after a sleep. Screens that show "today only" data
 * (Appointment Notes) key their queries on it, so yesterday's data is never
 * presented as today's. The server still resolves the date itself.
 */
export function useBusinessDate(timeZone) {
  const zone = timeZone || 'UTC';
  // Derived on every render (so any re-render is current); the effect below
  // only forces a re-render when the date has changed while the screen idles.
  const date = civilDateString(new Date(), zone);
  const [, setTick] = useState(0);

  useEffect(() => {
    const sync = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (civilDateString(new Date(), zone) !== date) setTick((t) => t + 1);
    };
    const boundary = nextBusinessMidnight(date, zone);
    const timeout = setTimeout(sync, Math.max(boundary.getTime() - Date.now() + 25, 0));
    const watchdog = setInterval(sync, WATCHDOG_MS);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearTimeout(timeout);
      clearInterval(watchdog);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [zone, date]);

  return date;
}

export default useBusinessDate;
