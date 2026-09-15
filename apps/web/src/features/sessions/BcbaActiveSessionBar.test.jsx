import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * BcbaActiveSessionBar — the persistent, cross-page active-session indicator
 * (spec §D / Phase 22). It appears while a session is running on non-panel BCBA
 * pages, shows the child NAME and the running timer (never an id), links to the
 * panel, and hides on the panel route (where the detailed hero already shows).
 */
const CHILD = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const getBcbaPanel = vi.fn();
const listClients = vi.fn(() => Promise.resolve({ items: [{ id: CHILD, firstName: 'Raymond', lastName: 'More' }] }));
const listStaff = vi.fn(() => Promise.resolve({ items: [] }));

vi.mock('@/api/client', () => ({
  getBcbaPanel: (...a) => getBcbaPanel(...a),
  listClients: (...a) => listClients(...a),
  listStaff: (...a) => listStaff(...a),
}));

let host; let root; let BcbaActiveSessionBar;
beforeEach(async () => { ({ BcbaActiveSessionBar } = await import('./BcbaActiveSessionBar.jsx')); getBcbaPanel.mockReset(); });
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const mountAt = (path) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><BcbaActiveSessionBar /></MemoryRouter></QueryClientProvider>,
  ));
};
const waitFor = async (re) => { for (let i = 0; i < 80; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found in: ${host.textContent.slice(0, 200)}`); };
const settle = async () => { for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const runningPanel = () => ([{ appointmentId: 'a1', clientId: CHILD, startedAt: new Date(Date.now() - 5000).toISOString(), isRunning: true }]);

describe('BcbaActiveSessionBar', () => {
  it('shows the running session with child name + timer on a non-panel page, no ids', async () => {
    getBcbaPanel.mockResolvedValue(runningPanel());
    mountAt('/scheduling');
    await waitFor(/Session in progress/);
    expect(host.textContent).toContain('Raymond More');
    expect(host.textContent).toMatch(/\d{1,2}:\d{2}/); expect(host.textContent).not.toMatch(/:\d{2}:\d{2}/); // H:MM, no seconds (Phase 4 §13)
    expect(host.textContent).not.toContain(CHILD);
    const link = host.querySelector('a');
    expect(link.getAttribute('href')).toContain('/sessions/panel');
  });

  it('hides on the panel route (the hero shows there instead)', async () => {
    getBcbaPanel.mockResolvedValue(runningPanel());
    mountAt('/sessions/panel');
    await settle();
    expect(host.textContent).not.toMatch(/Session in progress/);
  });

  it('renders nothing when there is no running session', async () => {
    getBcbaPanel.mockResolvedValue([{ appointmentId: 'a1', clientId: CHILD, isRunning: false }]);
    mountAt('/scheduling');
    await settle();
    expect(host.textContent).toBe('');
  });
});
