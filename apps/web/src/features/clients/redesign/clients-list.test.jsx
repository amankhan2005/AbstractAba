import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { formatStatusLabel } from '@/lib/format';

/**
 * Company Admin Clients page. Rows and counts come from GET /v1/clients and
 * GET /v1/clients/summary. Account (Active / Hold / Discharged) is the
 * server-derived `accountStatus`; the referral stage (Referred / Intake) is
 * shown with the client and never as the account.
 */
const api = { listClients: vi.fn(), getClientsSummary: vi.fn() };
vi.mock('@/api/client', () => ({
  listClients: (...a) => api.listClients(...a),
  getClientsSummary: (...a) => api.getClientsSummary(...a),
}));
let permissions = [];
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ status: 'authenticated', principal: { permissions } }),
  useOrgTimezone: () => 'America/New_York',
}));

const here = dirname(fileURLToPath(import.meta.url));
const RAY = {
  id: 'c-ray', clientNumber: 'CL-0001', firstName: 'raymond', lastName: 'k', status: 'REFERRED', accountStatus: 'HOLD',
  intakeWorkflowStatus: 'NOT_SENT', approvedWeeklyHours: null,
  serviceAuthorizations: [{ serviceType: 'FBA', status: 'APPROVED' }],
  careTeam: { bcba: { name: 'Lovelace, Ada' }, rbt: null },
};
const BEA = {
  id: 'c-bea', clientNumber: 'CL-0002', firstName: 'Bea', lastName: 'Stone', status: 'REFERRED', accountStatus: 'ACTIVE',
  intakeWorkflowStatus: 'COMPLETE', approvedWeeklyHours: 12,
  serviceAuthorizations: [{ serviceType: 'ABA', status: 'SENT' }, { serviceType: 'FBA', status: 'DENIED' }],
  careTeam: { bcba: { name: 'Shah, Priya' }, rbt: { name: 'Patel, Nia' } },
};
const DEE = { ...RAY, id: 'c-dee', clientNumber: 'CL-0003', firstName: 'Dee', lastName: 'Diaz', status: 'DISCHARGED', accountStatus: 'DISCHARGED', intakeWorkflowStatus: 'MISSING_DOCUMENTS', serviceAuthorizations: [] };
const page = (items, nextCursor = null) => ({ items, meta: { nextCursor, limit: 25 } });
const SUMMARY = { total: 9, account: { ACTIVE: 5, HOLD: 3, DISCHARGED: 1 }, stage: { REFERRED: 2, INTAKE: 1, ACTIVE: 4, ON_HOLD: 1, DISCHARGED: 1 } };

let host; let root; let mod; let lastLocation;
function Probe() { lastLocation = useLocation(); return null; }

beforeEach(async () => {
  permissions = ['clients.read', 'clients.create'];
  for (const fn of Object.values(api)) fn.mockReset();
  api.listClients.mockResolvedValue(page([RAY, BEA, DEE]));
  api.getClientsSummary.mockResolvedValue(SUMMARY);
  mod = await import('./ClientsListRedesign.jsx');
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/clients']}>
        <Probe />
        <Routes>
          <Route path="/clients" element={<mod.ClientsListRedesign />} />
          <Route path="/clients/new" element={<div>intake</div>} />
          <Route path="/clients/:clientId" element={<div>client profile</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
};
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const text = () => document.body.textContent;
const button = (re, scope = document) => [...scope.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); }); await settle(); };
const rows = () => [...host.querySelectorAll('.rx-cl__row')];
const cell = (row, label) => row.querySelector(`[data-label="${label}"]`);

describe('Clients page — layout and data', () => {
  it('renders the new header, summary, toolbar and table with Add Client for creators', async () => {
    mount(); await settle();
    expect(host.querySelector('.rx-cl__title').textContent).toBe('Clients');
    expect(host.querySelector('.rx-cl__subtitle').textContent).toMatch(/account readiness/);
    expect(button(/^Add Client$/)).toBeTruthy();
    expect([...host.querySelectorAll('.rx-cl__listhead span')].map((s) => s.textContent)).toEqual(['Client', 'Account', 'Care team', 'Intake', 'Authorizations', 'Hours/wk', 'Actions']);
    expect(api.listClients).toHaveBeenCalledWith({ limit: 25 });
    expect(text()).not.toMatch(/Children|Add child/);
  });

  it('summary cards show the server counts (no invented metrics)', async () => {
    mount(); await settle();
    const cards = [...host.querySelectorAll('.rx-cl__stat')].map((c) => [c.querySelector('.rx-cl__stat-label').textContent, c.querySelector('.rx-cl__stat-value').textContent, c.querySelector('.rx-cl__stat-hint').textContent]);
    expect(cards).toEqual([
      ['Total clients', '9', '1 discharged'],
      ['Active', '5', 'Parent/guardian details on file'],
      ['Hold', '3', 'Needs parent details or on hold'],
      ['Referral & intake', '3', 'Clients in referred or intake stage'],
    ]);
  });

  it('rows render real client data with capitalized, separate status types', async () => {
    mount(); await settle();
    const [ray, bea, dee] = rows();
    expect(ray.querySelector('.rx-cl__name').textContent).toBe('Raymond K');
    expect(ray.querySelector('.rx-cl__meta').textContent).toBe('CL-0001Referred');
    expect(cell(ray, 'Account').textContent).toBe('Hold');
    expect(cell(ray, 'Care team').textContent).toBe('BCBAAda LovelaceRBTNot assigned');
    expect(cell(ray, 'Intake').textContent).toBe('Not sent');
    expect(cell(ray, 'Authorizations').textContent).toBe('FBAApprovedABANot sent');
    expect(cell(ray, 'Hours/wk').textContent).toBe('Not set');
    expect(cell(bea, 'Account').textContent).toBe('Active');
    expect(cell(bea, 'Intake').textContent).toBe('Complete');
    expect(cell(bea, 'Authorizations').textContent).toBe('FBADeniedABASent');
    expect(cell(bea, 'Hours/wk').textContent).toBe('12 hrs');
    expect(cell(dee, 'Account').textContent).toBe('Discharged');
    expect(cell(dee, 'Intake').textContent).toBe('Missing documents');
  });

  it('"Referred" is never shown as an Account status — even for a referred client', async () => {
    mount(); await settle();
    const accounts = rows().map((r) => cell(r, 'Account').textContent);
    expect(accounts).toEqual(['Hold', 'Active', 'Discharged']);
    expect(accounts.some((a) => /Referred|Intake/.test(a))).toBe(false);
    // The referral stage is still visible, separately, with the client.
    expect(rows()[1].querySelector('.rx-cl__stage-chip').textContent).toBe('Referred');
    // Every status pill on the page is display-capitalized (no raw lowercase enum text).
    const pills = [...host.querySelectorAll('.rx-badge, .rx-cl__stage-chip')].map((b) => b.textContent.trim());
    expect(pills.length).toBeGreaterThan(0);
    for (const p of pills) expect(p).toMatch(/^[A-Z][a-z]*( [a-z]+)*$/);
  });
});

describe('Clients page — search, filters, navigation', () => {
  it('search is sent to the API after typing pauses; Account and Stage filters are server params', async () => {
    mount(); await settle();
    const input = host.querySelector('input[type="search"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'ray');
    await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
    await settle();
    expect(api.listClients).toHaveBeenLastCalledWith({ limit: 25, search: 'ray' });

    await click(button(/^Hold$/, host.querySelector('[aria-label="Account status"]')));
    expect(api.listClients).toHaveBeenLastCalledWith({ limit: 25, search: 'ray', accountStatus: 'HOLD' });

    const stage = host.querySelector('.rx-cl__stage button');
    await click(stage);
    const referred = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Referred');
    await click(referred);
    expect(api.listClients).toHaveBeenLastCalledWith({ limit: 25, search: 'ray', accountStatus: 'HOLD', status: 'REFERRED' });
  });

  it('clicking the Active summary card filters by Account = Active', async () => {
    mount(); await settle();
    await click([...host.querySelectorAll('.rx-cl__stat')].find((c) => c.textContent.startsWith('Active')));
    expect(api.listClients).toHaveBeenLastCalledWith({ limit: 25, accountStatus: 'ACTIVE' });
    expect(host.querySelector('[aria-label="Account status"] [aria-checked="true"]').textContent).toBe('Active');
  });

  it('opening a client goes to the Client Profile', async () => {
    mount(); await settle();
    await click(rows()[1]);
    expect(lastLocation.pathname).toBe('/clients/c-bea');
    expect(text()).toContain('client profile');
  });

  it('Load more uses the server cursor and appends rows', async () => {
    api.listClients.mockResolvedValueOnce(page([RAY], 'cur-1')).mockResolvedValueOnce(page([BEA]));
    mount(); await settle();
    await click(button(/^Load more$/));
    expect(api.listClients).toHaveBeenLastCalledWith({ limit: 25, cursor: 'cur-1' });
    expect(rows()).toHaveLength(2);
  });

  it('Add Client is hidden without clients.create', async () => {
    permissions = ['clients.read'];
    mount(); await settle();
    expect(button(/^Add Client$/)).toBeUndefined();
  });
});

describe('Clients page — states', () => {
  it('empty roster, filtered empty, loading and error states', async () => {
    api.listClients.mockResolvedValue(page([]));
    mount(); await settle();
    expect(text()).toContain('No clients yet');
    await click(button(/^Hold$/, host.querySelector('[aria-label="Account status"]')));
    expect(text()).toContain('No clients match your filters');
    await click(button(/^Clear filters$/));
    expect(api.listClients).toHaveBeenLastCalledWith({ limit: 25 });

    act(() => root.unmount()); host.remove(); root = undefined;
    api.listClients.mockReturnValue(new Promise(() => {}));
    mount(); await settle();
    expect(host.querySelector('[aria-label="Loading clients"]')).toBeTruthy();

    act(() => root.unmount()); host.remove(); root = undefined;
    api.listClients.mockReset(); api.listClients.mockRejectedValueOnce({ response: { status: 500 } }).mockResolvedValue(page([RAY]));
    mount(); await settle();
    expect(text()).toContain('We couldn’t load your clients');
    await click(button(/^Retry$/));
    expect(rows()).toHaveLength(1);
  });

  it('layout: max-w-7xl, one shared column definition, tablet/mobile breakpoints', () => {
    const css = readFileSync(resolve(here, '../../../styles/redesign.css'), 'utf8');
    const block = css.slice(css.indexOf('/* ============================ CLIENTS'));
    expect(block).toMatch(/\.rx-cl \{ max-width: 80rem;/);
    expect(block).toMatch(/\.rx-cl__listhead, \.rx-cl__row \{ display: grid; grid-template-columns: var\(--cl-cols\);/);
    expect(block).toMatch(/@media \(max-width: 980px\) \{\s*\.rx-cl__listhead \{ display: none; \}/);
    expect(block).toMatch(/@media \(max-width: 560px\)[^]*\.rx-cl__row \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(css).not.toMatch(/rx-careteam/);
  });
});

describe('formatStatusLabel', () => {
  it('capitalizes status values for display without changing them', () => {
    const cases = {
      active: 'Active', ACTIVE: 'Active', referred: 'Referred', intake: 'Intake', complete: 'Complete',
      'not sent': 'Not sent', NOT_SENT: 'Not sent', approved: 'Approved', hold: 'Hold', HOLD: 'Hold',
      ON_HOLD: 'On hold', MISSING_DOCUMENTS: 'Missing documents', DISCHARGED: 'Discharged',
    };
    for (const [value, label] of Object.entries(cases)) expect(formatStatusLabel(value)).toBe(label);
    expect(formatStatusLabel(null)).toBe('');
  });
});
