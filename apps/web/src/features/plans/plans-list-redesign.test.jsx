import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * /plans roster redesign + real response mapping.
 *
 * Asserts the page loads real persisted plans through listPlans (which maps the
 * API's { data, meta } envelope to { items, meta }), humanises the status
 * filters (Draft/Active/Archived — never a concatenated "DRAFTACTIVEARCHIVED"),
 * renders inside a max-w-7xl container, and shows real empty and error states
 * without swallowing the error into an empty list.
 */
const listPlans = vi.fn();
vi.mock('@/api/client', () => ({ listPlans: (...a) => listPlans(...a) }));
let perms = ['plans.read', 'plans.create', 'plans.update'];
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { permissions: perms } }) }));

let host; let root; let PlansListPage;

beforeEach(async () => {
  ({ PlansListPage } = await import('./PlansListPage.jsx'));
  perms = ['plans.read', 'plans.create', 'plans.update'];
  listPlans.mockReset();
});
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={['/plans']}><PlansListPage /></MemoryRouter></QueryClientProvider>,
  ));
};
const waitFor = async (re) => { for (let i = 0; i < 80; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found in: ${host.textContent.slice(0, 300)}`); };

describe('PlansListPage redesign', () => {
  it('loads real plans from listPlans and renders them with humanised status badges', async () => {
    listPlans.mockResolvedValue({ items: [
      { id: 'p-1', title: 'Behavior Support', status: 'ACTIVE', reviewDate: '2025-06-01', updatedAt: '2025-05-01' },
      { id: 'p-2', title: 'Early Intervention', status: 'DRAFT', updatedAt: '2025-05-02' },
    ], meta: { nextCursor: null } });
    mount();
    await waitFor(/Behavior Support/);
    expect(host.textContent).toContain('Early Intervention');
    // Humanised status labels, not raw enums.
    expect(host.textContent).toContain('Active');
    expect(host.textContent).toContain('Draft');
  });

  it('renders the four status filters with humanised labels and never a concatenated enum string', async () => {
    listPlans.mockResolvedValue({ items: [], meta: { nextCursor: null } });
    mount();
    await waitFor(/No treatment plans yet/);
    const tabs = [...host.querySelectorAll('.rx-st__filter')].map((b) => b.textContent);
    expect(tabs).toEqual(['All statuses', 'Draft', 'Active', 'Archived']);
    expect(host.textContent).not.toMatch(/DRAFTACTIVEARCHIVED/);
    expect(host.textContent).not.toMatch(/DRAFT|ARCHIVED/); // no raw enum leaks
  });

  it('changing the status filter refetches with the real backend enum value', async () => {
    listPlans.mockResolvedValue({ items: [], meta: { nextCursor: null } });
    mount();
    await waitFor(/No treatment plans yet/);
    const activeTab = [...host.querySelectorAll('.rx-st__filter')].find((b) => b.textContent === 'Active');
    await act(async () => { activeTab.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const calls = listPlans.mock.calls.map((c) => c[0]);
    expect(calls.some((p) => p && p.status === 'ACTIVE')).toBe(true);
  });

  it('lays the page out in a max-w-7xl container', async () => {
    listPlans.mockResolvedValue({ items: [], meta: { nextCursor: null } });
    mount();
    await waitFor(/No treatment plans yet/);
    expect(host.querySelector('.max-w-7xl')).toBeTruthy();
  });

  it('shows a real error state (not an empty list) when the API fails', async () => {
    listPlans.mockRejectedValue(new Error('boom'));
    mount();
    await waitFor(/We couldn’t load treatment plans/);
    expect(host.textContent).toContain('Retry');
  });

  it('hides New plan when the caller cannot create', async () => {
    perms = ['plans.read'];
    listPlans.mockResolvedValue({ items: [], meta: { nextCursor: null } });
    mount();
    await waitFor(/No treatment plans/);
    expect(host.textContent).not.toContain('New plan');
  });
});

/**
 * The redesigned list surfaces REAL counts for the current view and richer card
 * metadata. Nothing here may be invented: a field the API did not return must be
 * omitted, not shown as a placeholder, and no count may exceed the rows shown.
 */
describe('PlansListPage — redesign', () => {
  it('summarises the plans actually returned, with no invented numbers', async () => {
    listPlans.mockResolvedValue({ items: [
      { id: 'p-1', title: 'Behavior Support', status: 'ACTIVE', updatedAt: '2025-05-01' },
      { id: 'p-2', title: 'Early Intervention', status: 'ACTIVE', updatedAt: '2025-05-02' },
      { id: 'p-3', title: 'Parent Training', status: 'DRAFT', updatedAt: '2025-05-03' },
    ], meta: { nextCursor: null } });
    mount();
    await waitFor(/Behavior Support/);

    const t = host.textContent;
    expect(t).toMatch(/Active2/);
    expect(t).toMatch(/Draft1/);
    expect(t).toMatch(/Archived0/);
    expect(t).toMatch(/Total plans3/);
  });

  it('omits card metadata the API did not return rather than showing placeholders', async () => {
    listPlans.mockResolvedValue({ items: [
      { id: 'p-1', title: 'Behavior Support', status: 'ACTIVE' },
    ], meta: { nextCursor: null } });
    mount();
    await waitFor(/Behavior Support/);

    const t = host.textContent;
    expect(t).not.toMatch(/Effective/);
    expect(t).not.toMatch(/Review /);
    expect(t).not.toMatch(/Not available|Not set|undefined|null/);
  });

  it('shows client, BCBA and effective date in US format when present', async () => {
    listPlans.mockResolvedValue({ items: [
      {
        id: 'p-1', title: 'Behavior Support', status: 'ACTIVE',
        clientName: 'Raymond K', bcbaName: 'Ben Carter',
        effectiveDate: '2026-09-12', goalCount: 3, programCount: 2,
      },
    ], meta: { nextCursor: null } });
    mount();
    await waitFor(/Behavior Support/);

    const t = host.textContent;
    expect(t).toContain('Raymond K');
    expect(t).toContain('Ben Carter');
    expect(t).toContain('Effective 09/12/2026');
    expect(t).not.toMatch(/2026-09-12/);
    // Plan CONTENT shown as a count inside the card — not a link to a
    // standalone Goals area.
    expect(t).toMatch(/3 goals · 2 programs/);
  });

  it('shows no summary strip at all when there are no plans', async () => {
    listPlans.mockResolvedValue({ items: [], meta: { nextCursor: null } });
    mount();
    await waitFor(/No treatment plans yet/);
    expect(host.textContent).not.toMatch(/Total plans/);
  });
});
