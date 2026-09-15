import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore, useOrgTimezone } from './store';

// How often an open session re-reads /auth/me while the tab stays visible, and
// the minimum gap between focus-triggered reads.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FOCUS_THROTTLE_MS = 60 * 1000;

/**
 * Keeps every open session on the organization's CURRENT timezone.
 *
 * The organization timezone is owned by the server and delivered on /auth/me
 * (organizationTimezone); the auth store feeds it to the shared formatter
 * (setDefaultTimeZone) and useOrgTimezone. When a Company Admin changes it,
 * sessions that are already open — the admin's other tabs, BCBAs, RBTs — pick
 * it up here: /auth/me is re-read when the tab regains focus or becomes
 * visible (throttled), and periodically while it stays open.
 *
 * When the timezone actually changes, cached server data is invalidated so
 * business dates the API derived in the old zone (calendar days, "today",
 * start eligibility, payroll and billing periods) are fetched again.
 */
export function OrganizationTimezoneSync() {
  const queryClient = useQueryClient();
  const status = useAuthStore((s) => s.status);
  const refreshPrincipal = useAuthStore((s) => s.refreshPrincipal);
  const timeZone = useOrgTimezone();
  const previous = useRef(timeZone);

  useEffect(() => {
    if (previous.current && timeZone && previous.current !== timeZone) void queryClient.invalidateQueries();
    previous.current = timeZone;
  }, [timeZone, queryClient]);

  useEffect(() => {
    if (status !== 'authenticated') return undefined;
    let lastRead = Date.now();
    const read = () => {
      lastRead = Date.now();
      refreshPrincipal().catch(() => { /* keep the current session on a failed read */ });
    };
    const onFocus = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRead >= FOCUS_THROTTLE_MS) read();
    };
    const interval = setInterval(() => { if (document.visibilityState === 'visible') read(); }, REFRESH_INTERVAL_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [status, refreshPrincipal]);

  return null;
}

export default OrganizationTimezoneSync;
