import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * REGRESSION — care-team mutation controls must be Company/Admin-only in the UI.
 *
 * Blueprint Parts 3/7/12/21: a BCBA (and RBT) reaches a child's "Care team" tab
 * to VIEW the roster, but must NOT be shown Assign / Edit / End / Remove — those
 * are Company/Admin actions. The backend already rejects the call
 * (clients.care_team.manage); this pins that the interface does not present an
 * action the role cannot take. Any React act() warning fails the test (Part 30).
 */

const listCareTeam = vi.fn();
const listStaff = vi.fn();

vi.mock('@/api/client', () => ({
  listCareTeam: (...a) => listCareTeam(...a),
  listStaff: (...a) => listStaff(...a),
  assignCareTeam: vi.fn(),
  removeCareTeam: vi.fn(),
  updateAssignment: vi.fn(),
  endAssignment: vi.fn(),
  messageCareTeam: vi.fn(),
}));

// The permission set the principal carries is swapped per test via this ref.
let currentPermissions = [];
vi.mock('@/auth/store', () => ({
  useAuthStore: (selector) => selector({ principal: { permissions: currentPermissions } }),
}));

const ACTIVE_MEMBER = {
  id: 'a-1', staffName: 'Lovelace, Ada', staffTitle: 'Lead BCBA', role: 'BCBA',
  status: 'ACTIVE', isPrimary: true, weeklyAssignedHours: 20, effectiveStartDate: '2026-01-01',
};

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

let AssignmentPanel;
beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ AssignmentPanel } = await import('./AssignmentPanel.jsx'));
  listCareTeam.mockReset(); listStaff.mockReset();
  listCareTeam.mockResolvedValue([ACTIVE_MEMBER]);
  listStaff.mockResolvedValue({ items: [] });
});

let host; let root;
const mount = () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <AssignmentPanel clientId="c-1" />
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

const waitForText = async (re) => {
  for (let i = 0; i < 50; i += 1) {
    if (re.test(host.textContent)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  throw new Error(`text ${re} never appeared`);
};
const buttonByText = (re) => [...host.querySelectorAll('button')].find((b) => re.test(b.textContent));

describe('AssignmentPanel — care-team mutation is Company/Admin-only', () => {
  it('Company/Admin (holds clients.care_team.manage) sees Assign + Edit/End/Remove', async () => {
    currentPermissions = ['clients.read', 'clients.update', 'clients.care_team.manage'];
    mount();
    await waitForText(/Lovelace, Ada/);
    expect(buttonByText(/assign staff/i)).toBeTruthy();
    expect(buttonByText(/^End$/)).toBeTruthy();
    expect(host.querySelector('button[aria-label="Remove"]')).toBeTruthy();
    expect(host.querySelector('button[aria-label="Edit"]')).toBeTruthy();
  });

  it('BCBA (clients.update but NOT care_team.manage) sees the roster but NO mutation controls', async () => {
    currentPermissions = ['clients.read', 'clients.update']; // a BCBA on their caseload
    mount();
    await waitForText(/Lovelace, Ada/); // roster still visible (read-only)
    expect(buttonByText(/assign staff/i)).toBeFalsy();
    expect(buttonByText(/^End$/)).toBeFalsy();
    expect(host.querySelector('button[aria-label="Remove"]')).toBeFalsy();
    expect(host.querySelector('button[aria-label="Edit"]')).toBeFalsy();
  });

  it('RBT (clients.read only) sees the roster but NO mutation controls', async () => {
    currentPermissions = ['clients.read'];
    mount();
    await waitForText(/Lovelace, Ada/);
    expect(buttonByText(/assign staff/i)).toBeFalsy();
    expect(host.querySelector('button[aria-label="Remove"]')).toBeFalsy();
    expect(host.querySelector('button[aria-label="Edit"]')).toBeFalsy();
  });
});
