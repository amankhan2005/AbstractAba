import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Organization timezone propagation to sessions that are already open (a BCBA
 * or RBT signed in while the Company Admin changes the zone). /auth/me is the
 * source; the formatter and cached server data follow it. No user or staff
 * timezone exists, and the browser's zone never decides.
 */
const fetchMe = vi.fn();
vi.mock('@/api/client', () => ({ fetchMe: (...a) => fetchMe(...a) }));

let useAuthStore; let OrganizationTimezoneSync; let formatDateTime; let setDefaultTimeZone;
let host; let root; let qc;
const BCBA = { user: { email: 'bcba@harbor.test' }, roles: ['bcba'], permissions: ['sessions.read'], organizationActive: true, activeTenantId: 't-1', organizationTimezone: 'America/New_York' };

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-09-15T15:00:00Z'), toFake: ['Date', 'setInterval', 'clearInterval'] });
  ({ useAuthStore } = await import('./store'));
  ({ OrganizationTimezoneSync } = await import('./OrganizationTimezoneSync.jsx'));
  ({ formatDateTime, setDefaultTimeZone } = await import('@/lib/format'));
  useAuthStore.setState({ status: 'authenticated', principal: { ...BCBA } });
  fetchMe.mockReset();
  host = document.createElement('div'); document.body.appendChild(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => root.render(<QueryClientProvider client={qc}><OrganizationTimezoneSync /></QueryClientProvider>));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useAuthStore.setState({ status: 'unknown', principal: null });
  vi.useRealTimers();
});

const focus = async () => { await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); await Promise.resolve(); }); };

describe('organization timezone propagation', () => {
  it('formats in the ORGANIZATION timezone, whatever the browser zone is', () => {
    const at = '2026-09-15T03:30:00.000Z';
    expect(formatDateTime(at)).toBe(formatDateTime(at, 'America/New_York'));
    expect(formatDateTime(at)).toContain('09/14/2026 11:30 PM');
    expect(formatDateTime(at, 'Pacific/Honolulu')).toContain('09/14/2026 5:30 PM');
  });

  it('an open BCBA/RBT session adopts a changed organization timezone on focus; cached data is refetched', async () => {
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    fetchMe.mockResolvedValue({ ...BCBA, organizationTimezone: 'America/Chicago' });
    vi.setSystemTime(new Date('2026-09-15T15:02:00Z')); // past the focus throttle
    await focus();
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().principal.organizationTimezone).toBe('America/Chicago');
    expect(formatDateTime('2026-09-15T03:30:00.000Z')).toContain('09/14/2026 10:30 PM');
    expect(invalidate).toHaveBeenCalled();
  });

  it('also re-reads periodically while the tab stays open, and throttles focus reads', async () => {
    fetchMe.mockResolvedValue({ ...BCBA });
    await focus(); // within the throttle window after mount → no read
    expect(fetchMe).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000); await Promise.resolve(); });
    expect(fetchMe).toHaveBeenCalledTimes(1);
  });

  it('a failed /auth/me read keeps the current session and timezone', async () => {
    fetchMe.mockRejectedValue(new Error('offline'));
    vi.setSystemTime(new Date('2026-09-15T15:02:00Z'));
    await focus();
    expect(useAuthStore.getState()).toMatchObject({ status: 'authenticated' });
    expect(useAuthStore.getState().principal.organizationTimezone).toBe('America/New_York');
  });

  it('an unchanged principal does not replace session state or refetch data', async () => {
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const before = useAuthStore.getState().principal;
    fetchMe.mockResolvedValue({ ...BCBA });
    vi.setSystemTime(new Date('2026-09-15T15:02:00Z'));
    await focus();
    expect(useAuthStore.getState().principal).toBe(before);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('applyOrganizationTimezone ignores missing values and is a no-op for the same zone', () => {
    const before = useAuthStore.getState().principal;
    useAuthStore.getState().applyOrganizationTimezone(null);
    useAuthStore.getState().applyOrganizationTimezone('America/New_York');
    expect(useAuthStore.getState().principal).toBe(before);
    setDefaultTimeZone('America/New_York');
  });
});
