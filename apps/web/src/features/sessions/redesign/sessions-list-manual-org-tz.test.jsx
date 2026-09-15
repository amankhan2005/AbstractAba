import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Review Queue (/sessions) — manual sessions. Several BCBA and RBT manual
 * sessions on ONE business day appear as separate rows in the normal queue,
 * labelled "Manual entry", with their exact times read in the ORGANIZATION's
 * timezone (never the browser's) and their own worked minutes.
 */
const listSessions = vi.fn();
vi.mock('@/api/client', () => ({
  listSessions: (...a) => listSessions(...a),
  listClients: vi.fn(async () => ({ items: [] })),
  listStaff: vi.fn(async () => ({ items: [] })),
}));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ principal: { roles: ['bcba'] } }),
  useOrgTimezone: () => 'America/New_York',
}));

const ROWS = [
  // BCBA 10:15–11:45 Client A · BCBA 1:00–2:15 PM Client B · RBT 10:30–12:00 Client A (09/13/2026, New York)
  { id: 's-rbt', source: 'MANUAL', status: 'FROZEN', childName: 'Client A', clinicianName: 'Nia Patel', startedAt: '2026-09-13T14:30:00.000Z', endedAt: '2026-09-13T16:00:00.000Z', workedMinutes: 90 },
  { id: 's-bcba-2', source: 'MANUAL', status: 'FROZEN', childName: 'Client B', clinicianName: 'Test1 J', startedAt: '2026-09-13T17:00:00.000Z', endedAt: '2026-09-13T18:15:00.000Z', workedMinutes: 75 },
  { id: 's-bcba-1', source: 'MANUAL', status: 'FROZEN', childName: 'Client A', clinicianName: 'Test1 J', startedAt: '2026-09-13T14:15:00.000Z', endedAt: '2026-09-13T15:45:00.000Z', workedMinutes: 90 },
];

let host; let root; let SessionsListRedesign;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 11:00 PM New York on 09/13 — already 09/14 in UTC and in most of the world.
  vi.setSystemTime(new Date('2026-09-14T03:00:00Z'));
  ({ SessionsListRedesign } = await import('./SessionsListRedesign.jsx'));
  listSessions.mockReset();
  listSessions.mockResolvedValue({ items: ROWS });
});
afterEach(() => {
  if (root) act(() => root.unmount()); host?.remove(); root = undefined; host = undefined;
  vi.useRealTimers();
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><MemoryRouter><SessionsListRedesign /></MemoryRouter></QueryClientProvider>));
};
const settle = async () => { for (let i = 0; i < 30; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe('Review Queue — manual sessions in the organization timezone', () => {
  it('lists each same-day manual session separately with its exact org-timezone time and worked minutes', async () => {
    mount(); await settle();
    const table = [...host.querySelectorAll('tbody tr')].map((tr) => tr.textContent);
    expect(table).toHaveLength(3);
    const find = (child, clinician, time) => table.find((t) => t.includes(child) && t.includes(clinician) && t.includes(time));
    expect(find('Client A', 'Test1 J', '09/13/2026 · 10:15 AM')).toMatch(/1h 30m.*Manual entry/);
    expect(find('Client B', 'Test1 J', '09/13/2026 · 1:00 PM')).toMatch(/1h 15m.*Manual entry/);
    expect(find('Client A', 'Nia Patel', '09/13/2026 · 10:30 AM')).toMatch(/1h 30m.*Manual entry/);
    expect(host.textContent).not.toMatch(/9:30 AM|12:00 AM/);
  });

  it('"Today" is the org business date, not the browser/UTC date', async () => {
    mount(); await settle();
    const today = host.querySelector('.rx-todaysessions');
    expect(today).not.toBeNull();
    expect(today.textContent).toContain('3 today');
    expect(today.textContent).toContain('09/13/2026 10:15 AM · 1h 30m');
  });
});
