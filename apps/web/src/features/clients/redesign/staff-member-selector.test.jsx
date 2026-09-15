import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Care team → Assign staff → "Staff member" selector.
 *
 * Regression: the placeholder was written as a JSX attribute string
 * (placeholder="Select active staff…"), where escapes are NOT processed, so
 * the literal backslash sequence rendered. The selector must show a clean
 * placeholder, real ACTIVE staff names (first + middle + last), never an id, and
 * submit the real staffProfile id.
 */
const listCareTeam = vi.fn();
const listStaff = vi.fn();
const assignCareTeam = vi.fn();
vi.mock('@/api/client', () => ({
  listCareTeam: (...a) => listCareTeam(...a),
  listStaff: (...a) => listStaff(...a),
  assignCareTeam: (...a) => assignCareTeam(...a),
  removeCareTeam: vi.fn(), updateAssignment: vi.fn(), endAssignment: vi.fn(), messageCareTeam: vi.fn(),
}));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ status: 'authenticated', principal: { permissions: ['clients.read', 'clients.update', 'clients.care_team.manage'] } }),
}));

const JOHN = '0f9e2c1a-7b3d-4e5f-8a9b-0c1d2e3f4a5b';
const STAFF = [
  { id: JOHN, firstName: 'john', middleName: 'michael', lastName: 'smith', status: 'ACTIVE', roleKeys: ['bcba'] },
  { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', firstName: 'Nia', lastName: 'Patel', status: 'ACTIVE', roleKeys: ['rbt'] },
  { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', firstName: 'Old', lastName: 'Staffer', status: 'INACTIVE', roleKeys: ['bcba'] },
  { id: '3c4d5e6f-7a8b-4c9d-0e1f-2a3b4c5d6e7f', firstName: '', lastName: '', status: 'ACTIVE', roleKeys: ['bcba'] },
];

let host; let root; let mod;
beforeEach(async () => {
  mod = await import('./AssignmentPanel.jsx');
  listCareTeam.mockReset().mockResolvedValue([]);
  listStaff.mockReset().mockResolvedValue({ items: STAFF });
  assignCareTeam.mockReset().mockResolvedValue({ id: 'as-1' });
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

const settle = async () => { for (let i = 0; i < 30; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { AssignmentPanel } = mod;
  act(() => root.render(<QueryClientProvider client={qc}><ToastProvider><MemoryRouter><AssignmentPanel clientId="c-1" /></MemoryRouter></ToastProvider></QueryClientProvider>));
};
const button = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); };

describe('Staff member selector', () => {
  it('requests ACTIVE staff with the server page cap', async () => {
    mount(); await settle();
    expect(listStaff).toHaveBeenCalledWith({ status: 'ACTIVE', limit: 100 });
  });

  it('shows the clean placeholder, real names only (no ids, no escapes), and persists the real staffProfile id', async () => {
    mount(); await settle();
    await click(button(/^Assign staff$/));
    const text = document.body.textContent;
    expect(text).toContain('Select an active staff member');
    expect(text).not.toMatch(/\\u2026|u2026/);

    const selects = [...document.querySelectorAll('.rx-select')];
    const staffSelect = selects.find((s) => s.querySelector('.rx-select__value')?.textContent === 'Select an active staff member');
    expect(staffSelect).toBeTruthy();
    await click(staffSelect.querySelector('.rx-select__trigger'));
    const options = [...staffSelect.querySelectorAll('.rx-select__opt')].map((o) => o.textContent.replace('BCBA', '').trim());
    // Role BCBA (default): only ACTIVE, BCBA-eligible, NAMED staff.
    expect(options).toEqual(['John Michael Smith']);
    expect(staffSelect.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);

    await click([...staffSelect.querySelectorAll('.rx-select__opt')][0]);
    expect(staffSelect.querySelector('.rx-select__value').textContent.replace(/^BCBA/, '')).toBe('John Michael Smith');
    await click(button(/^Confirm assignment$/));
    expect(assignCareTeam).toHaveBeenCalledWith('c-1', expect.objectContaining({ staffProfileId: JOHN, role: 'BCBA' }));
  });

  it('staffOptionsForRole: RBT seat lists RBT-eligible active staff by name', () => {
    expect(mod.staffOptionsForRole(STAFF, 'RBT').map((o) => [o.value, o.label])).toEqual([[STAFF[1].id, 'Nia Patel']]);
    expect(mod.STAFF_PLACEHOLDER).toBe('Select an active staff member');
  });
});
