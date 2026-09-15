import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { zonedWallTimeToUtc } from '@/lib/businessDate';
import { nextBusinessMidnight, useBusinessDate } from '@/lib/useBusinessDate';

/**
 * Appointment Notes are CURRENT-business-date only. A screen left open past
 * org midnight (refetchOnWindowFocus is off app-wide) must not keep showing
 * yesterday's "Test1 has added notes" or yesterday's note as today's.
 */
const listAppointmentNotesOverview = vi.fn();
const getAppointmentNote = vi.fn();
vi.mock('@/api/client', () => ({
  listAppointmentNotesOverview: (...a) => listAppointmentNotesOverview(...a),
  getAppointmentNote: (...a) => getAppointmentNote(...a),
  saveAppointmentNote: vi.fn(),
  deleteAppointmentNote: vi.fn(),
  listClients: vi.fn(async () => ({ items: [] })),
}));
let roles = ['org_admin'];
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ principal: { roles } }),
  useOrgTimezone: () => 'America/New_York',
}));

const TZ = 'America/New_York';
const wall = (y, m, d, hh, mm = 0) => zonedWallTimeToUtc(y, m, d, hh, mm, 0, TZ);

let host; let root;
beforeEach(() => {
  roles = ['org_admin'];
  listAppointmentNotesOverview.mockReset(); getAppointmentNote.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(wall(2026, 9, 13, 23, 50));
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; vi.useRealTimers(); });

const mount = (el) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 } } });
  act(() => root.render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>));
};
const settle = async () => { for (let i = 0; i < 25; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const wake = async () => { await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); await settle(); };

describe('useBusinessDate', () => {
  it('next org midnight is DST-correct', () => {
    expect(nextBusinessMidnight('2026-09-13', TZ).toISOString()).toBe('2026-09-14T04:00:00.000Z');
    expect(nextBusinessMidnight('2026-10-31', TZ).toISOString()).toBe('2026-11-01T04:00:00.000Z'); // EDT midnight
    expect(nextBusinessMidnight('2026-11-01', TZ).toISOString()).toBe('2026-11-02T05:00:00.000Z'); // EST midnight
  });

  it('rolls to the new business date at org midnight even when no timer fired (sleep)', async () => {
    let seen = [];
    function Probe() { const d = useBusinessDate(TZ); seen.push(d); return <span>{d}</span>; }
    mount(<Probe />);
    expect(host.textContent).toBe('2026-09-13');
    vi.setSystemTime(wall(2026, 9, 14, 8, 0));
    await wake();
    expect(host.textContent).toBe('2026-09-14');
    seen = [];
    await wake(); // no change → no new date
    expect(seen.every((d) => d === '2026-09-14')).toBe(true);
  });
});

describe('Company Admin notification across midnight', () => {
  it('yesterday\'s "Test1 has added notes" disappears on 09/14 and today\'s list is fetched', async () => {
    const { AppointmentNotesOverview } = await import('./AppointmentNotesOverview.jsx');
    listAppointmentNotesOverview.mockResolvedValueOnce({ businessDate: '2026-09-13', items: [
      { id: 'n1', appointmentId: 'appt-ray', businessDate: '2026-09-13', authorFirstName: 'test1', updatedAt: '2026-09-13T20:00:00.000Z' },
    ] });
    mount(<AppointmentNotesOverview />);
    await settle();
    expect(host.textContent).toContain('Test1 has added notes');

    listAppointmentNotesOverview.mockResolvedValueOnce({ businessDate: '2026-09-14', items: [] });
    vi.setSystemTime(wall(2026, 9, 14, 8, 0));
    await wake();
    expect(listAppointmentNotesOverview).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain('has added notes');
  });
});

describe('BCBA note panel across midnight', () => {
  it('yesterday\'s note is not shown as today\'s; the panel offers a fresh note for 09/14', async () => {
    roles = ['bcba'];
    const { AppointmentNotePanel } = await import('./AppointmentNotePanel.jsx');
    getAppointmentNote.mockResolvedValueOnce({ appointmentId: 'a1', businessDate: '2026-09-13', exists: true, note: 'Yesterday note', clientId: null, clientName: null, canEdit: true });
    mount(<AppointmentNotePanel appointmentId="a1" />);
    await settle();
    expect(host.textContent).toContain('Yesterday note');

    getAppointmentNote.mockResolvedValueOnce({ appointmentId: 'a1', businessDate: '2026-09-14', exists: false, note: null, clientId: null, clientName: null, canEdit: true });
    vi.setSystemTime(wall(2026, 9, 14, 8, 0));
    await wake();
    expect(host.textContent).not.toContain('Yesterday note');
    expect(host.textContent).toContain('Add appointment note');
  });
});
