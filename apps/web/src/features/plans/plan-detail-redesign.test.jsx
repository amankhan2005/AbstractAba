import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Treatment Plan detail page.
 *
 * Asserts the premium detail page renders its summary cards, the ACTIVE status,
 * goals and the goal -> program tree, and attractive empty states — and, per the
 * detail-page changes:
 *   - a REAL "Last updated" value (from plan.updatedAt), never a broken â;
 *   - the REAL child name (plan.childName) and responsible-BCBA name
 *     (plan.responsibleBcbaName), never "Child" / "Staff member";
 *   - the standalone Programs section / KPI is NOT rendered;
 *   - Delete requires confirmation, Cancel does not delete, and confirming calls
 *     the real deletePlan API.
 * All act()-clean.
 */

const getPlan = vi.fn();
const deletePlan = vi.fn(() => Promise.resolve({ planId: 'p-1', deleted: true }));
const noop = vi.fn(() => Promise.resolve({}));
vi.mock('@/api/client', () => ({
  getPlan: (...a) => getPlan(...a),
  getClient: () => Promise.resolve({ id: 'c-1', firstName: 'Jamie', lastName: 'Rivera' }),
  updateGoal: noop, addGoal: noop, addProgram: noop, addTarget: noop,
  archiveGoal: noop, archiveProgram: noop, archiveTarget: noop, updateTarget: noop,
  archivePlan: noop, deletePlan: (...a) => deletePlan(...a),
  listClients: () => Promise.resolve({ items: [] }),
  listStaff: () => Promise.resolve({ items: [] }),
  getBcbaPanel: () => Promise.resolve([]),
}));
let perms = ['plans.read', 'plans.update', 'plans.archive'];
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { permissions: perms } }) }));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useParams: () => ({ planId: 'p-1' }) }));

let host; let root; let PlanDetailPage;

const withTree = {
  // The server now resolves the real child + BCBA names and the updatedAt value
  // onto the plan; the page renders those directly.
  plan: {
    id: 'p-1', clientId: 'c-1', title: 'Behavior Support', status: 'ACTIVE',
    responsibleBcbaStaffId: 's-1abcdef', responsibleBcbaName: 'Jane Doe',
    childName: 'Jamie Rivera', version: 3, updatedAt: '2026-02-10T15:30:00.000Z',
  },
  goals: [
    { id: 'g-1', description: 'Functional Communication', term: 'SHORT_TERM', priority: 2, status: 'IN_PROGRESS', progress: 80, version: 5,
      programs: [{ id: 'pr-1', name: 'Manding', archivedAt: null, targets: [] }] },
  ],
};
const empty = { plan: { ...withTree.plan }, goals: [] };

beforeEach(async () => {
  ({ PlanDetailPage } = await import('./PlanDetailPage.jsx'));
  perms = ['plans.read', 'plans.update', 'plans.archive'];
  getPlan.mockReset();
  deletePlan.mockClear();
});
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={['/plans/p-1']}><PlanDetailPage /></MemoryRouter></QueryClientProvider>,
  ));
};
const waitFor = async (re, scope = () => host.textContent) => { for (let i = 0; i < 80; i += 1) { if (re.test(scope())) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found in: ${scope().slice(0, 300)}`); };

describe('PlanDetailPage', () => {
  it('renders the hero, ACTIVE status, summary cards and goals', async () => {
    getPlan.mockResolvedValue(withTree);
    mount();
    await waitFor(/Functional Communication/);
    expect(host.textContent).toContain('Treatment Plan');
    expect(host.textContent.toLowerCase()).toContain('active');
    expect(host.textContent).toContain('Goals');
    expect(host.textContent).toContain('Last updated');
    // a progress bar is rendered for the goal
    expect(host.querySelector('.rx-progressbar')).toBeTruthy();
    // the goal's program still renders inside the goal tree
    expect(host.textContent).toContain('Manding');
  });

  it('shows the REAL last-updated value, not a broken placeholder', async () => {
    getPlan.mockResolvedValue(withTree);
    mount();
    await waitFor(/Last updated/);
    // 2026-02-10 → MM/DD/YYYY from formatDateTime; and never the mojibake â.
    expect(host.textContent).toContain('02/10/2026');
    expect(host.textContent).not.toContain('â');
    expect(host.textContent).not.toContain('Not available');
  });

  it('shows the real child name and responsible BCBA, not generic placeholders', async () => {
    getPlan.mockResolvedValue(withTree);
    mount();
    await waitFor(/Jamie Rivera/);
    expect(host.textContent).toContain('Jamie Rivera');
    expect(host.textContent).toContain('Jane Doe');
    expect(host.textContent).not.toContain('Staff member');
    // no raw id leaks
    expect(host.textContent).not.toContain('s-1abcdef');
    expect(host.textContent).not.toContain('c-1');
  });

  it('does NOT render a standalone Programs section or KPI', async () => {
    getPlan.mockResolvedValue(withTree);
    mount();
    await waitFor(/Functional Communication/);
    expect(host.textContent).not.toContain('No programs yet');
    expect(host.textContent).not.toContain('Every program in this plan');
    // No "Programs" summary/section heading (the word only survives as lowercase
    // "Add program" inside the goal tree, and the program name "Manding").
    expect(host.textContent).not.toContain('Programs');
  });

  it('shows attractive empty state when there are no goals', async () => {
    getPlan.mockResolvedValue(empty);
    mount();
    await waitFor(/No goals yet/);
    expect(host.textContent).toContain('No goals yet');
    expect(host.textContent).not.toContain('No programs yet');
  });

  it('does not show DRAFT for an ACTIVE plan', async () => {
    getPlan.mockResolvedValue(withTree);
    mount();
    await waitFor(/Functional Communication/);
    expect(host.textContent.toLowerCase()).not.toContain('draft');
  });

  it('Delete requires confirmation; Cancel does not delete', async () => {
    getPlan.mockResolvedValue(withTree);
    mount();
    await waitFor(/Functional Communication/);
    // click the Delete trigger in the header
    const trigger = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete');
    expect(trigger).toBeTruthy();
    await act(async () => { trigger.click(); });
    // confirm dialog (portaled to body) appears
    await waitFor(/Delete treatment plan\?/, () => document.body.textContent);
    expect(document.body.textContent).toContain('This action cannot be undone');
    // Cancel closes it and does NOT call the API
    const cancel = [...document.body.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel');
    await act(async () => { cancel.click(); });
    expect(deletePlan).not.toHaveBeenCalled();
  });

  it('confirming Delete calls the real deletePlan API', async () => {
    getPlan.mockResolvedValue(withTree);
    mount();
    await waitFor(/Functional Communication/);
    const trigger = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete');
    await act(async () => { trigger.click(); });
    await waitFor(/Delete treatment plan\?/, () => document.body.textContent);
    // the confirm button in the dialog footer
    const confirmBtn = [...document.body.querySelectorAll('.rx-modal__foot button')].find((b) => b.textContent.trim() === 'Delete');
    expect(confirmBtn).toBeTruthy();
    await act(async () => { confirmBtn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(deletePlan).toHaveBeenCalledWith('p-1');
  });

  it('offers no Add Goal control (goal creation is not part of this page)', async () => {
    getPlan.mockResolvedValue(withTree);
    mount();
    await waitFor(/Functional Communication/);
    const text = host.textContent;
    expect(text).not.toMatch(/add goal|\+ goal|create goal|new goal/i);
    const goalButtons = [...host.querySelectorAll('button, a')].filter((b) => /goal/i.test(b.textContent) && !/archive goal/i.test(b.textContent));
    expect(goalButtons.map((b) => b.textContent)).toEqual([]);
    expect(host.querySelector('input[placeholder="Goal description"]')).toBeFalsy();
  });

  it('shows the no-goals empty state without prompting to add a goal', async () => {
    getPlan.mockResolvedValue(empty);
    mount();
    await waitFor(/No goals yet/);
    expect(host.textContent).not.toMatch(/add(ing)? (the first )?goal/i);
    expect([...host.querySelectorAll('button')].some((b) => /goal/i.test(b.textContent))).toBe(false);
  });

  it('hides Delete from a caller without plans.archive', async () => {
    perms = ['plans.read', 'plans.update'];
    getPlan.mockResolvedValue(withTree);
    mount();
    await waitFor(/Functional Communication/);
    const trigger = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete');
    expect(trigger).toBeFalsy();
  });
});
