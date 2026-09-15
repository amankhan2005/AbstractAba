import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Fix 1 — a child may hold MULTIPLE ABA authorizations; each renders as its own
 * card with its own units, and an "Add ABA" action stays available. Archiving one
 * calls the per-record archive endpoint. act()-clean.
 */
const listServiceAuthorizations = vi.fn();
const archiveServiceAuthorization = vi.fn();
const createServiceAuthorization = vi.fn();
vi.mock('@/api/client', () => ({
  listServiceAuthorizations: (...a) => listServiceAuthorizations(...a),
  createServiceAuthorization: (...a) => createServiceAuthorization(...a),
  updateServiceAuthorization: vi.fn(),
  transitionServiceAuthorization: vi.fn(),
  archiveServiceAuthorization: (...a) => archiveServiceAuthorization(...a),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let AuthorizationsPanel;

beforeEach(async () => {
  ({ AuthorizationsPanel } = await import('./AuthorizationsPanel.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  listServiceAuthorizations.mockReset(); archiveServiceAuthorization.mockReset(); createServiceAuthorization.mockReset();
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><ToastProvider><AuthorizationsPanel clientId="c-1" /></ToastProvider></QueryClientProvider>));
};
const waitFor = async (re, where = () => host.textContent) => { for (let i = 0; i < 80; i += 1) { if (re.test(where())) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found`); };
const btnByText = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };

describe('AuthorizationsPanel — multiple ABA (Fix 1)', () => {
  it('renders two ABA authorizations as separate cards with independent units', async () => {
    listServiceAuthorizations.mockResolvedValue([
      { id: 'a1', serviceType: 'ABA', status: 'APPROVED', authorizationNumber: 'AUTH-001', units: 100, usedUnits: 20, remainingUnits: 80, history: [] },
      { id: 'a2', serviceType: 'ABA', status: 'APPROVED', authorizationNumber: 'AUTH-002', units: 50, usedUnits: 5, remainingUnits: 45, history: [] },
    ]);
    mount();
    await waitFor(/AUTH-001/);
    expect(host.textContent).toMatch(/AUTH-001/);
    expect(host.textContent).toMatch(/AUTH-002/);
    // independent unit lines
    expect(host.textContent).toMatch(/100 authorized · 20 used · 80 remaining/);
    expect(host.textContent).toMatch(/50 authorized · 5 used · 45 remaining/);
  });

  it('keeps an "Add ABA" action available even when ABA authorizations already exist', async () => {
    listServiceAuthorizations.mockResolvedValue([
      { id: 'a1', serviceType: 'ABA', status: 'APPROVED', authorizationNumber: 'AUTH-001', units: 100, usedUnits: 0, remainingUnits: 100, history: [] },
    ]);
    mount();
    await waitFor(/AUTH-001/);
    expect(btnByText(/Add ABA/)).toBeTruthy();
    expect(btnByText(/Add FBA/)).toBeTruthy();
  });

  it('archiving one authorization calls the per-record archive endpoint', async () => {
    listServiceAuthorizations.mockResolvedValue([
      { id: 'a1', serviceType: 'ABA', status: 'NOT_SENT', authorizationNumber: 'AUTH-001', units: 100, usedUnits: 0, remainingUnits: 100, history: [] },
    ]);
    archiveServiceAuthorization.mockResolvedValue({ id: 'a1', deleted: true });
    mount();
    await waitFor(/AUTH-001/);
    await click(document.querySelector('button[aria-label="Archive authorization"]'));
    await waitFor(/Archive authorization\?/, () => document.body.textContent);
    await click(btnByText(/^Archive$/));
    expect(archiveServiceAuthorization).toHaveBeenCalledWith('c-1', 'a1');
  });

  it('Fix 1B — Add ABA defaults Start Date to TODAY (dynamic, local calendar day, not hardcoded)', async () => {
    listServiceAuthorizations.mockResolvedValue([]);
    mount();
    await waitFor(/No ABA authorization/);
    await click(btnByText(/Add ABA/));
    await waitFor(/Start date/, () => document.body.textContent);
    const d = new Date();
    const todayISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // The shared date picker shows the internal YYYY-MM-DD value as MM/DD/YYYY.
    const dateInput = document.querySelector('input[aria-label="Start date"]');
    expect(dateInput).toBeTruthy();
    const [yyyy, mm, dd] = todayISO.split('-');
    expect(dateInput.value).toBe(`${mm}/${dd}/${yyyy}`);
  });

  it('Fix 1B — authorization dates render MM/DD/YYYY (not ISO)', async () => {
    listServiceAuthorizations.mockResolvedValue([
      { id: 'a1', serviceType: 'ABA', status: 'APPROVED', authorizationNumber: 'AUTH-001', startDate: '2026-08-27', endDate: '2026-12-31', units: 100, usedUnits: 0, remainingUnits: 100, history: [] },
    ]);
    mount();
    await waitFor(/AUTH-001/);
    expect(host.textContent).toMatch(/08\/27\/2026/);
    expect(host.textContent).toMatch(/12\/31\/2026/);
    // the raw ISO form must not be shown to the user
    expect(host.textContent).not.toMatch(/2026-08-27/);
  });
});
