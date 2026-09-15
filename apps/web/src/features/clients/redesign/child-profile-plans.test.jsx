import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Child Profile → Treatment Plans (spec Change 3).
 *
 * Asserts the section renders THIS child's real plan (via listPlans({clientId}),
 * the shared plan system — no duplicate API), surfaces an active-plan summary
 * with View/Edit, and that Create/New treatment plan carries the child context
 * to the shared editor as /plans/new?clientId=<thisChild> so the plan is
 * associated with the correct child. Also covers the empty state.
 */

const CHILD = {
  client: { id: 'c-77', firstName: 'Aman', lastName: 'Khan', clientNumber: 'CL-1', status: 'ACTIVE', dateOfBirth: '2018-03-04', version: 1, intakeWorkflowStatus: 'RECEIVED' },
  careTeam: [{ id: 'a-r', role: 'RBT', status: 'ACTIVE', staffName: 'Doe, Jane' }],
  guardians: [], contacts: [], serviceAuthorizations: [],
};

const listPlans = vi.fn();
vi.mock('@/api/client', () => ({
  getClient: vi.fn(async () => CHILD),
  listPlans: (...a) => listPlans(...a),
  getPlan: vi.fn(async () => ({ plan: { id: 'p-1', status: 'DRAFT', version: 1 } })),
  updatePlan: vi.fn(async () => ({})),
}));
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { roles: ['BCBA'], permissions: ['plans.read', 'plans.create', 'plans.update'] } }) }));

let host; let root; let BcbaChildView; let lastNav;

beforeEach(async () => {
  ({ BcbaChildView } = await import('./BcbaChildView.jsx'));
  listPlans.mockReset();
  lastNav = null;
});
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

function EditorStub() {
  const loc = useLocation();
  return <div data-testid="editor">EDITOR {loc.search}</div>;
}

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/clients/c-77']}>
          <Routes>
            <Route path="/clients/:clientId" element={<BcbaChildView />} />
            <Route path="/plans/new" element={<EditorStub />} />
            <Route path="/plans/:planId" element={<div data-testid="detail">DETAIL</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  ));
};
const waitFor = async (re) => { for (let i = 0; i < 100; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found in: ${host.textContent.slice(0, 400)}`); };
const clickText = async (label) => {
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const openPlanTab = async () => {
  await waitFor(/Clinical summary/);
  const tab = [...host.querySelectorAll('button')].find((b) => /Treatment plan/.test(b.textContent));
  await act(async () => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

describe('Child Profile → Treatment Plans', () => {
  it('lists THIS child\'s plan via the shared listPlans({clientId}) and shows an active-plan summary', async () => {
    listPlans.mockResolvedValue({ items: [{ id: 'p-1', title: 'Behavior Support', status: 'ACTIVE', updatedAt: '2025-05-01' }] });
    mount();
    await openPlanTab();
    await waitFor(/Behavior Support/);
    // Queried with the child's id, not tenant-wide.
    expect(listPlans).toHaveBeenCalledWith({ clientId: 'c-77' });
    expect(host.textContent).toMatch(/Active treatment plan/i);
    expect(host.textContent).toContain('Active');
  });

  it('empty state offers Create treatment plan and carries the child context to the shared editor', async () => {
    listPlans.mockResolvedValue({ items: [] });
    mount();
    await openPlanTab();
    await waitFor(/No treatment plan yet/);
    await clickText('Create treatment plan');
    expect(host.querySelector('[data-testid="editor"]')).toBeTruthy();
    expect(host.textContent).toContain('clientId=c-77');
  });

  it('New treatment plan (header) also carries the child context', async () => {
    listPlans.mockResolvedValue({ items: [{ id: 'p-1', title: 'Behavior Support', status: 'ACTIVE', updatedAt: '2025-05-01' }] });
    mount();
    await openPlanTab();
    await waitFor(/Behavior Support/);
    await clickText('New treatment plan');
    expect(host.textContent).toContain('clientId=c-77');
  });

  it('surfaces a real error state when the plans query fails (not a wrong-child / empty fake)', async () => {
    listPlans.mockRejectedValue(new Error('boom'));
    mount();
    await openPlanTab();
    await waitFor(/couldn|Retry/i);
    expect(host.textContent).toMatch(/Retry/);
  });
});
