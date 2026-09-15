import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';
import { asList } from '@/api/client';

/**
 * REGRESSION — #1 (AuthorizationsPanel crash) + #7 (BCBA plan activation).
 *   asList() is the client-layer contract normaliser that guarantees list
 *   endpoints hand the UI an array, so `(query.data ?? []).map` can never throw
 *   on a drifted `{items}`/`{data}`/malformed body.
 *   The BCBA child view exposes an Activate action that moves a DRAFT plan to
 *   ACTIVE (so it reaches the assigned RBT) via the existing updatePlan lifecycle.
 */

describe('asList — API list contract normaliser (fixes the .map crash)', () => {
  it('passes arrays through', () => expect(asList([1, 2])).toEqual([1, 2]));
  it('unwraps { items }', () => expect(asList({ items: [1] })).toEqual([1]));
  it('unwraps { data }', () => expect(asList({ data: [2] })).toEqual([2]));
  it('degrades a malformed object to []', () => expect(asList({ foo: 'bar' })).toEqual([]));
  it('degrades null/undefined to []', () => { expect(asList(null)).toEqual([]); expect(asList(undefined)).toEqual([]); });
  it('result is always .map-able', () => { expect(() => asList({ nope: 1 }).map((x) => x)).not.toThrow(); });
});

// ---- BCBA plan activation --------------------------------------------------

const getClient = vi.fn();
const listPlans = vi.fn();
const getPlan = vi.fn();
const updatePlan = vi.fn();
vi.mock('@/api/client', async (orig) => ({
  ...(await orig()),
  getClient: (...a) => getClient(...a),
  listPlans: (...a) => listPlans(...a),
  getPlan: (...a) => getPlan(...a),
  updatePlan: (...a) => updatePlan(...a),
}));
vi.mock('@/auth/store', () => ({ useAuthStore: (s) => s({ principal: { permissions: ['clients.read', 'plans.update'], roles: ['bcba'] } }) }));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root;
const mount = async () => {
  const { BcbaChildView } = await import('./BcbaChildView.jsx');
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <MemoryRouter initialEntries={['/clients/c-1']}>
        <Routes><Route path="/clients/:clientId" element={<BcbaChildView />} /></Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  ));
};
const waitFor = async (re) => { for (let i = 0; i < 60; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`missing ${re}: ${host.textContent.slice(0, 300)}`); };
const clickButton = async (re) => { const b = [...host.querySelectorAll('button')].find((x) => re.test(x.textContent)); await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };

describe('BcbaChildView — plan activation (#7)', () => {
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error');
    getClient.mockResolvedValue({ client: { id: 'c-1', firstName: 'Aman', lastName: 'Khan', status: 'ACTIVE' }, careTeam: [], guardians: [], medical: [] });
    listPlans.mockResolvedValue({ items: [{ id: 'p-1', name: 'Functional Communication', status: 'DRAFT' }] });
    getPlan.mockResolvedValue({ plan: { id: 'p-1', version: 3, status: 'DRAFT' }, goals: [] });
    updatePlan.mockResolvedValue({ id: 'p-1', status: 'ACTIVE' });
  });
  afterEach(() => {
    if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
    const w = actWarnings(); consoleErrorSpy.mockRestore();
    expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
    vi.clearAllMocks();
  });

  it('shows Activate on a DRAFT plan and activates via updatePlan(status: ACTIVE) with the current version', async () => {
    await mount();
    // switch to the Treatment plan tab
    await waitFor(/Treatment plan/);
    await clickButton(/Treatment plan/);
    await waitFor(/Functional Communication/);
    await clickButton(/^Activate$/);
    await waitFor(/Plan activated/);
    // let the onSuccess invalidate→refetch settle inside act() before asserting
    for (let i = 0; i < 6; i += 1) { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
    expect(getPlan).toHaveBeenCalledWith('p-1');
    expect(updatePlan).toHaveBeenCalledWith('p-1', { status: 'ACTIVE' }, 3);
  });
});
