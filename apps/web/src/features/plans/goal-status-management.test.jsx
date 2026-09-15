import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Spec Module 8.2 — a BCBA (plans.update) moves a goal through the REAL clinical
 * statuses (NOT_STARTED/IN_PROGRESS/MET/DISCONTINUED) and records progress via
 * the authoritative updateGoal op (with the goal version for If-Match). A
 * read-only viewer sees no editing controls. act()-clean.
 */
const getPlan = vi.fn();
const updateGoal = vi.fn();
const noop = vi.fn();

vi.mock('@/api/client', () => ({
  getPlan: (...a) => getPlan(...a),
  updateGoal: (...a) => updateGoal(...a),
  addGoal: noop, addProgram: noop, addTarget: noop,
  archiveGoal: noop, archiveProgram: noop, archiveTarget: noop, updateTarget: noop,
  archivePlan: noop,
  // The redesigned detail page resolves the child's name for the hero. Mocked
  // here so the module access doesn't throw; the assertions below are unchanged.
  getClient: () => Promise.resolve({ id: 'c-1abc234', firstName: 'Test', lastName: 'Child' }),
}));

let perms = ['plans.read', 'plans.update', 'plans.archive'];
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { permissions: perms } }) }));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useParams: () => ({ planId: 'p-1' }) }));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let PlanDetailPage;

const PLAN = {
  plan: { id: 'p-1', clientId: 'c-1abc234', title: 'Plan', status: 'ACTIVE', responsibleBcbaStaffId: 's-1abc234', version: 3 },
  goals: [{ id: 'g-1', description: 'Increase manding', term: 'SHORT_TERM', priority: 2, status: 'NOT_STARTED', progress: 0, version: 5, programs: [] }],
};

beforeEach(async () => {
  ({ PlanDetailPage } = await import('./PlanDetailPage.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  getPlan.mockReset(); updateGoal.mockReset();
  getPlan.mockResolvedValue(PLAN);
  updateGoal.mockResolvedValue({ ...PLAN.goals[0], status: 'IN_PROGRESS', version: 6 });
  perms = ['plans.read', 'plans.update', 'plans.archive'];
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={['/plans/p-1']}><PlanDetailPage /></MemoryRouter></QueryClientProvider>,
  ));
};
const waitFor = async (re) => { for (let i = 0; i < 80; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found`); };

describe('PlanDetailPage — BCBA goal management (Module 8.2)', () => {
  it('offers the real clinical statuses and updates via updateGoal with the version', async () => {
    mount();
    await waitFor(/Increase manding/);
    const select = host.querySelector('select[aria-label="Goal status"]');
    expect(select, 'goal status selector renders for a BCBA').toBeTruthy();
    const opts = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(opts).toEqual(['NOT_STARTED', 'IN_PROGRESS', 'MET', 'DISCONTINUED']);
    // change status → updateGoal called with {status} + goal version
    const setV = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setV.call(select, 'IN_PROGRESS');
    await act(async () => { select.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); });
    expect(updateGoal).toHaveBeenCalledWith('p-1', 'g-1', { status: 'IN_PROGRESS' }, 5);
  });

  it('records progress via updateGoal on blur', async () => {
    mount();
    await waitFor(/Increase manding/);
    const input = host.querySelector('input[aria-label="Goal progress"]');
    expect(input).toBeTruthy();
    const setV = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setV.call(input, '40');
    await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await Promise.resolve(); });
    expect(updateGoal).toHaveBeenCalledWith('p-1', 'g-1', { progress: 40 }, 5);
  });

  it('a read-only viewer (no plans.update) sees no goal status editor', async () => {
    perms = ['plans.read'];
    mount();
    await waitFor(/Increase manding/);
    expect(host.querySelector('select[aria-label="Goal status"]')).toBeFalsy();
  });
});
