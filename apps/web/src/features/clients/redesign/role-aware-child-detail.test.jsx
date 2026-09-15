import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * REGRESSION — one child, three genuinely different experiences (Parts 3/6/13/34).
 *   Company → the full child editor (Edit + Guardian/Insurance tabs).
 *   BCBA    → a clinical view (Clinical summary + Treatment plan), read-only care
 *             team, no child editor, no Assign controls, no payroll.
 *   RBT     → a minimal execution view (Start session, Current plan, This week),
 *             no guardian data, no payroll, no care-team controls.
 * Any React act() warning fails the test (Part 28).
 */

const CHILD = {
  client: { id: 'c-1', firstName: 'Aman', lastName: 'Khan', clientNumber: 'CL-1', status: 'ACTIVE', dateOfBirth: '2018-03-04', version: 1, intakeWorkflowStatus: 'RECEIVED' },
  careTeam: [
    { id: 'a-b', role: 'BCBA', status: 'ACTIVE', staffName: 'Lovelace, Ada' },
    { id: 'a-r', role: 'RBT', status: 'ACTIVE', staffName: 'Doe, Jane' },
  ],
  guardians: [], contacts: [], serviceAuthorizations: [],
};

vi.mock('@/api/client', () => ({
  getClient: vi.fn(async () => CHILD),
  listPlans: vi.fn(async () => ({ items: [{ id: 'p-1', name: 'Functional Communication', status: 'ACTIVE' }] })),
  getPlan: vi.fn(async () => ({ plan: { id: 'p-1', name: 'Functional Communication', status: 'ACTIVE' }, goals: [{ id: 'g-1', name: 'Requesting', programs: [{ id: 'pr-1', name: 'Mands', targets: [{ id: 't-1', name: 'Ask for break', weeklyFocus: true, weeklyInstructions: 'Prompt every 5 min' }] }] }] })),
  listSessions: vi.fn(async () => ({ items: [] })),
  listCareTeam: vi.fn(async () => CHILD.careTeam),
  listStaff: vi.fn(async () => ({ items: [] })),
  fetchChildProgress: vi.fn(async () => ({ goals: [] })),
  fetchChildAlerts: vi.fn(async () => ({ alerts: [], summary: {} })),
  transitionIntakeStatus: vi.fn(), updateClient: vi.fn(),
}));

let currentRoles = [];
vi.mock('@/auth/store', () => ({
  // Company roles carry clients.update (as the real Owner/Company Admin templates do).
  useAuthStore: (selector) => selector({ principal: { roles: currentRoles, permissions: currentRoles.includes('owner') ? ['clients.read', 'clients.update'] : [] } }),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

let RoleAwareChildDetail;
beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ RoleAwareChildDetail } = await import('./RoleAwareChildDetail.jsx'));
});

let host; let root;
const mount = () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/clients/c-1']}>
            <Routes><Route path="/clients/:clientId" element={<RoleAwareChildDetail />} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
};
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = undefined; host = undefined;
  const warnings = actWarnings();
  consoleErrorSpy.mockRestore();
  expect(warnings, `act() warnings: ${JSON.stringify(warnings)}`).toHaveLength(0);
});

const waitFor = async (re) => {
  for (let i = 0; i < 60; i += 1) {
    if (re.test(host.textContent)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  throw new Error(`text ${re} never appeared. Got: ${host.textContent.slice(0, 400)}`);
};
const hasButton = (re) => [...host.querySelectorAll('button')].some((b) => re.test(b.textContent));

describe('RoleAwareChildDetail', () => {
  it('BCBA → dedicated clinical view: clinical tabs, no child editor, no Assign controls', async () => {
    currentRoles = ['bcba'];
    mount();
    await waitFor(/Aman Khan/);
    expect(host.textContent).toMatch(/Clinical summary/);
    expect(host.textContent).toMatch(/Treatment plan/);
    expect(host.textContent).toMatch(/Assigned RBT/);
    // must NOT be the Company editor
    expect(hasButton(/^Edit$/)).toBe(false);
    expect(hasButton(/assign staff/i)).toBe(false);
    expect(host.textContent).not.toMatch(/Insurance/);
    // no payroll/hourly language
    expect(host.textContent).not.toMatch(/hourly|payroll|pay rate/i);
  });

  it('RBT → minimal execution view: Start session + plan + this week, no guardian/payroll/editor', async () => {
    currentRoles = ['rbt'];
    mount();
    await waitFor(/Aman Khan/);
    expect(hasButton(/start session/i)).toBe(true);
    expect(host.textContent).toMatch(/Current plan/);
    expect(host.textContent).toMatch(/This week/);
    expect(host.textContent).toMatch(/Functional Communication/);
    // minimal: no company editor, no assign, no payroll, no guardian contact UI
    expect(hasButton(/^Edit$/)).toBe(false);
    expect(hasButton(/assign staff/i)).toBe(false);
    expect(host.textContent).not.toMatch(/hourly|payroll|guardian email|Insurance/i);
  });

  it('Company → full child editor: Edit Client + Parent / Guardian tab present', async () => {
    currentRoles = ['owner'];
    mount();
    await waitFor(/Aman Khan/);
    expect(hasButton(/^Edit Client$/)).toBe(true);
    expect(host.textContent).toMatch(/Guardian/);
  });
});
