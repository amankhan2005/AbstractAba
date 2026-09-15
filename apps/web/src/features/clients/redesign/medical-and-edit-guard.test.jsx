import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * REGRESSION — GAP 1 UI (medical conditions/history) + GAP 2 UI (edit-route guard).
 *   - Company/Admin (clients.medical.manage) sees Add controls.
 *   - Clinicians see the medical record READ-ONLY (no Add/Edit/Remove).
 *   - BCBA/RBT navigating to /clients/:id/edit are redirected to their view.
 * Any React act() warning fails the test (Part 28).
 */

const listMedical = vi.fn();
vi.mock('@/api/client', () => ({
  listMedical: (...a) => listMedical(...a),
  addMedical: vi.fn(), updateMedical: vi.fn(), removeMedical: vi.fn(),
}));

let currentPermissions = [];
let currentRoles = [];
vi.mock('@/auth/store', () => ({
  useAuthStore: (selector) => selector({ principal: { permissions: currentPermissions, roles: currentRoles } }),
}));

// ClientFormPage is heavy; stub it so the guard test asserts routing, not the form.
vi.mock('@/features/clients/ClientFormPage', () => ({ ClientFormPage: () => <div>COMPANY CHILD EDITOR</div> }));

const ENTRIES = [
  { id: 'm-1', type: 'CONDITION', label: 'ADHD', status: 'ACTIVE', provider: 'Dr. Reed', onsetDate: '2020-01-01' },
  { id: 'm-2', type: 'HISTORY', label: 'Seizure 2021', status: 'RESOLVED', onsetDate: '2021-06-01' },
];

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

let host; let root;
const mountEl = (el, entries = ['/']) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}><ToastProvider>
        <MemoryRouter initialEntries={entries}>{el}</MemoryRouter>
      </ToastProvider></QueryClientProvider>,
    );
  });
};
beforeEach(() => { consoleErrorSpy = vi.spyOn(console, 'error'); listMedical.mockReset(); listMedical.mockResolvedValue(ENTRIES); });
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = undefined; host = undefined;
  const w = actWarnings();
  consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});
const waitFor = async (re) => {
  for (let i = 0; i < 60; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
  throw new Error(`text ${re} never appeared. Got: ${host.textContent.slice(0, 300)}`);
};
const hasButton = (re) => [...host.querySelectorAll('button')].some((b) => re.test(b.textContent));

describe('MedicalPanel', () => {
  it('Company/Admin sees conditions, history and Add controls', async () => {
    currentPermissions = ['clients.read', 'clients.medical.manage'];
    const { MedicalPanel } = await import('./MedicalPanel.jsx');
    mountEl(<MedicalPanel clientId="c-1" />);
    await waitFor(/ADHD/);
    expect(host.textContent).toMatch(/Medical conditions/);
    expect(host.textContent).toMatch(/Medical history/);
    expect(host.textContent).toMatch(/Seizure 2021/);
    expect(hasButton(/^Add$/)).toBe(true);
  });

  it('clinician (no medical.manage) sees the record READ-ONLY', async () => {
    currentPermissions = ['clients.read'];
    const { MedicalPanel } = await import('./MedicalPanel.jsx');
    mountEl(<MedicalPanel clientId="c-1" />);
    await waitFor(/ADHD/);
    expect(hasButton(/^Add$/)).toBe(false);
    expect(host.querySelector('button[aria-label="Edit"]')).toBeFalsy();
    expect(host.querySelector('button[aria-label="Remove"]')).toBeFalsy();
  });
});

describe('CompanyChildEditGuard', () => {
  const routeTree = (Guard) => (
    <Routes><Route path="/clients/:clientId/edit" element={<Guard />} /><Route path="/clients/:clientId" element={<div>ROLE CHILD VIEW</div>} /></Routes>
  );

  it('Company/Admin reaches the child editor', async () => {
    currentRoles = ['owner'];
    const { CompanyChildEditGuard } = await import('./CompanyChildEditGuard.jsx');
    mountEl(routeTree(CompanyChildEditGuard), ['/clients/c-1/edit']);
    await waitFor(/COMPANY CHILD EDITOR/);
  });

  it('BCBA is redirected away from the child editor', async () => {
    currentRoles = ['bcba'];
    const { CompanyChildEditGuard } = await import('./CompanyChildEditGuard.jsx');
    mountEl(routeTree(CompanyChildEditGuard), ['/clients/c-1/edit']);
    await waitFor(/ROLE CHILD VIEW/);
    expect(host.textContent).not.toMatch(/COMPANY CHILD EDITOR/);
  });

  it('RBT is redirected away from the child editor', async () => {
    currentRoles = ['rbt'];
    const { CompanyChildEditGuard } = await import('./CompanyChildEditGuard.jsx');
    mountEl(routeTree(CompanyChildEditGuard), ['/clients/c-1/edit']);
    await waitFor(/ROLE CHILD VIEW/);
    expect(host.textContent).not.toMatch(/COMPANY CHILD EDITOR/);
  });
});
