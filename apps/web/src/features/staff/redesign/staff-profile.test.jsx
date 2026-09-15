import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Company Admin Staff Profile. Everything shown comes from GET /v1/staff/:id
 * (and the sessions list for recent work); edits go through the existing
 * versioned PATCH. Credentials and Supervision are no longer part of the page.
 */
const api = {
  getStaff: vi.fn(), updateStaff: vi.fn(), listStaff: vi.fn(), listSessions: vi.fn(),
  adminResetMemberPassword: vi.fn(), resendStaffLoginEmail: vi.fn(),
};
vi.mock('@/api/client', () => Object.fromEntries(Object.keys({
  getStaff: 1, updateStaff: 1, listStaff: 1, listSessions: 1, adminResetMemberPassword: 1, resendStaffLoginEmail: 1,
}).map((k) => [k, (...a) => api[k](...a)])));

let permissions = [];
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ status: 'authenticated', principal: { permissions, organizationTimezone: 'America/New_York' } }),
  useOrgTimezone: () => 'America/New_York',
}));

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = ['staff.read', 'staff.manage', 'sessions.read', 'clients.read', 'payroll.read'];

const detail = (over = {}) => ({
  staff: {
    id: '11111111-1111-4111-8111-111111111111', userId: 'u-1', firstName: 'ada', middleName: 'King', lastName: 'lovelace',
    title: 'Lead BCBA', discipline: null, employeeNumber: 'EMP-0007', status: 'ACTIVE', startDate: '2026-02-01', version: 3,
    membershipId: 'm-1', roleKeys: ['bcba'], loginEmail: 'ada@example.com', hourlyPayRate: 62.5, ...over.staff,
  },
  account: { loginEmail: 'ada@example.com', membershipId: 'm-1', accountStatus: 'ACTIVE', roleKeys: ['bcba'], firstLoginCompleted: true, firstLoginAt: '2026-02-02T15:00:00Z', lastLoginAt: '2026-09-13T13:30:00Z', ...over.account },
  credentials: [{ id: 'c1', credentialType: 'BCBA', status: 'ACTIVE' }],
  supervisees: [{ id: 'l1', superviseeStaffId: 'raw-uuid-supervisee' }],
  supervisors: [],
  ...('caseload' in over ? { caseload: over.caseload } : {
    caseload: { activeClientCount: 2, assignments: [
      { assignmentId: 'a1', clientId: 'cl-1', clientName: 'Raymond K', clientStatus: 'ACTIVE', role: 'BCBA', isPrimary: true, weeklyAssignedHours: 6, effectiveStartDate: '2026-03-01' },
      { assignmentId: 'a2', clientId: 'cl-2', clientName: 'Bea Stone', clientStatus: 'ON_HOLD', role: 'BCBA', isPrimary: false, weeklyAssignedHours: null, effectiveStartDate: null },
    ] },
  }),
});
const STAFF_ID = '11111111-1111-4111-8111-111111111111';

let host; let root; let mod; let listMod; let lastLocation;
function LocationProbe() { lastLocation = useLocation(); return null; }

beforeEach(async () => {
  permissions = ADMIN;
  for (const fn of Object.values(api)) fn.mockReset();
  api.getStaff.mockResolvedValue(detail());
  api.listSessions.mockResolvedValue({ items: [
    { id: 's-1', childName: 'Raymond K', startedAt: '2026-09-13T14:15:00Z', workedMinutes: 90, status: 'FROZEN', source: 'MANUAL' },
    { id: 's-2', childName: 'Bea Stone', startedAt: '2026-09-12T13:00:00Z', workedMinutes: null, status: 'IN_PROGRESS', source: null },
  ], meta: {} });
  mod = await import('./StaffProfileRedesign.jsx');
  listMod = await import('./StaffListRedesign.jsx');
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

const mount = (path = `/staff/${STAFF_ID}`) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/staff" element={<listMod.StaffListRedesign />} />
          <Route path="/staff/:staffId" element={<mod.StaffProfileRedesign />} />
          <Route path="/staff/:staffId/edit" element={<mod.StaffEditRedirect />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  ));
  return qc;
};
const settle = async () => { for (let i = 0; i < 30; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const text = () => document.body.textContent;
const button = (re, scope = document) => [...scope.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); }); await settle(); };
const facts = (title) => {
  const card = [...host.querySelectorAll('.rx-card')].find((c) => c.querySelector('.rx-card__title')?.textContent === title);
  return Object.fromEntries([...card.querySelectorAll('.rx-sp__fact')].map((f) => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]));
};
const setInput = async (label, value) => {
  const field = [...document.querySelectorAll('.rx-formfield')].find((f) => f.textContent.startsWith(label));
  const input = field.querySelector('input');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('Staff Profile — data', () => {
  it('direct URL loads the correct staff member from the API (no prior page needed)', async () => {
    mount(); await settle();
    expect(api.getStaff).toHaveBeenCalledWith(STAFF_ID);
    expect(host.querySelector('.rx-sp__name').textContent).toBe('Ada King Lovelace');
    expect(host.querySelector('.rx-sp__hero').className).toContain('rx-sp__hero--bcba');
    expect([...host.querySelectorAll('.rx-sp__role')].map((r) => r.textContent)).toEqual(['BCBA']);
    expect(host.querySelector('.rx-sp__meta').textContent).toContain('ada@example.com');
    expect(host.querySelector('.rx-sp__meta').textContent).toContain('Employee ID EMP-0007');
  });

  it('summary, personal and professional sections render the real fields; empty optional fields read "Not provided"', async () => {
    mount(); await settle();
    const tiles = [...host.querySelectorAll('.rx-sp__stat')].map((t) => [t.querySelector('.rx-sp__stat-label').textContent, t.querySelector('.rx-sp__stat-value').textContent]);
    expect(tiles).toEqual([['Role', 'BCBA'], ['Employment status', 'Active'], ['Hourly pay rate', '$62.50/hr'], ['Active clients', '2']]);
    expect(facts('Personal information')).toEqual({ 'First name': 'Ada', 'Middle name': 'King', 'Last name': 'Lovelace', Email: 'ada@example.com' });
    expect(facts('Professional information')).toMatchObject({ Role: 'BCBA', Title: 'Lead BCBA', Discipline: 'Not provided', 'Employee ID': 'EMP-0007', 'Employment status': 'Active', 'Start date': '02/01/2026', 'Hourly pay rate': '$62.50/hr' });
    expect(text()).not.toMatch(/Phone|Location|Address/);
  });

  it('Credentials and Supervision are not rendered — even when the API still returns those arrays', async () => {
    mount(); await settle();
    expect(text()).not.toMatch(/Credential|Add credential|No credentials recorded|Supervision|Supervisee|Supervisor|No supervisees|No supervisors/);
    expect(text()).not.toContain('raw-uuid-supervisee');
  });

  it('assigned clients come from the caseload the API returned', async () => {
    mount(); await settle();
    const items = [...host.querySelectorAll('[aria-label="Assigned clients"] .rx-sp__item')];
    expect(items.map((i) => i.querySelector('.rx-sp__item-title').textContent)).toEqual(['Raymond K', 'Bea Stone']);
    expect(items[0].querySelector('.rx-sp__item-meta').textContent).toBe('BCBA · Primary · 6 hrs/week · Since 03/01/2026');
    expect(items[0].querySelector('a').getAttribute('href')).toBe('/clients/cl-1');
  });

  it('recent sessions reuse the sessions API filtered to this staff member', async () => {
    mount(); await settle();
    expect(api.listSessions).toHaveBeenCalledWith({ staffProfileId: STAFF_ID, limit: 5 });
    const rows = [...host.querySelectorAll('[aria-label="Recent sessions"] .rx-sp__item')];
    expect(rows[0].textContent).toContain('Raymond K');
    expect(rows[0].textContent).toContain('09/13/2026 10:15 AM · 1h 30m · Manual entry');
    expect(rows[0].textContent).toContain('Completed');
    expect(rows[1].textContent).toContain('In progress');
  });

  it('sections the API did not grant are omitted (no pay field, no caseload, no sessions permission) — no fake zeros', async () => {
    permissions = ['staff.read'];
    const d = detail({ caseload: undefined });
    delete d.staff.hourlyPayRate; delete d.caseload;
    api.getStaff.mockResolvedValue(d);
    mount(); await settle();
    expect(text()).not.toMatch(/Hourly pay rate|\$62\.50|Active clients|Assigned clients|Recent sessions/);
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(button(/Edit profile/)).toBeUndefined();
    expect(button(/Deactivate/)).toBeUndefined();
    expect([...host.querySelectorAll('.rx-sp__stat-label')].map((l) => l.textContent)).toEqual(['Role', 'Employment status', 'Tenure']);
  });

  it('inactive staff: status badge reads Inactive and the action is Reactivate', async () => {
    api.getStaff.mockResolvedValue(detail({ staff: { status: 'INACTIVE' } }));
    mount(); await settle();
    expect(host.querySelector('.rx-sp__chips').textContent).toContain('Inactive');
    expect(button(/^Reactivate$/)).toBeTruthy();
    expect(button(/^Deactivate$/)).toBeUndefined();
  });
});

describe('Staff Profile — edit and status', () => {
  it('Edit profile opens the editor; only changed fields are sent with the version; success refreshes the profile', async () => {
    api.updateStaff.mockResolvedValue({ id: STAFF_ID, version: 4 });
    mount(); await settle();
    await click(button(/^Edit profile$/));
    expect(document.querySelector('[role="dialog"]').textContent).toContain('Edit staff member');
    await setInput('Title', 'Clinical Director');
    await setInput('Middle name', '');
    api.getStaff.mockResolvedValue(detail({ staff: { title: 'Clinical Director', middleName: null, version: 4 } }));
    await click(button(/^Save changes$/));
    expect(api.updateStaff).toHaveBeenCalledTimes(1);
    expect(api.updateStaff).toHaveBeenCalledWith(STAFF_ID, { title: 'Clinical Director', middleName: null }, 3);
    expect(api.getStaff).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(facts('Professional information').Title).toBe('Clinical Director');
    expect(text()).toContain('Staff details saved.');
  });

  it('an unchanged save sends nothing (no duplicate pay-rate row)', async () => {
    mount(); await settle();
    await click(button(/^Edit profile$/));
    await click(button(/^Save changes$/));
    expect(api.updateStaff).not.toHaveBeenCalled();
  });

  it('API errors are surfaced in the editor and the dialog stays open', async () => {
    api.updateStaff.mockRejectedValue({ response: { status: 409, data: { error: { code: 'VERSION_CONFLICT', message: 'This record changed since you loaded it. Reload and try again.' } } } });
    mount(); await settle();
    await click(button(/^Edit profile$/));
    await setInput('Title', 'Changed');
    await click(button(/^Save changes$/));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.querySelector('[role="alert"]').textContent).toBe('This record changed since you loaded it. Reload and try again.');
  });

  it('the status editor offers only the real statuses (Active, Inactive)', async () => {
    mount(); await settle();
    await click(button(/^Edit profile$/));
    const field = [...document.querySelectorAll('.rx-formfield')].find((f) => f.textContent.startsWith('Status'));
    await click(field.querySelector('button'));
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['Active', 'Inactive']);
  });

  it('Deactivate asks for confirmation, then PATCHes status INACTIVE with the version and refreshes', async () => {
    api.updateStaff.mockResolvedValue({ id: STAFF_ID, status: 'INACTIVE', version: 4 });
    mount(); await settle();
    await click(button(/^Deactivate$/));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('Deactivate Ada King Lovelace?');
    expect(api.updateStaff).not.toHaveBeenCalled();
    api.getStaff.mockResolvedValue(detail({ staff: { status: 'INACTIVE', version: 4 } }));
    await click(button(/^Deactivate$/, dialog));
    expect(api.updateStaff).toHaveBeenCalledWith(STAFF_ID, { status: 'INACTIVE' }, 3);
    expect(button(/^Reactivate$/)).toBeTruthy();
    expect(text()).toContain('is now inactive.');
  });

  it('a failed status change is reported, never swallowed', async () => {
    api.updateStaff.mockRejectedValue({ response: { status: 403, data: { error: { message: 'Missing permission: staff.manage' } } } });
    mount(); await settle();
    await click(button(/^Deactivate$/));
    await click(button(/^Deactivate$/, document.querySelector('[role="dialog"]')));
    expect(text()).toContain('Missing permission: staff.manage');
  });
});

describe('Staff Profile — navigation and states', () => {
  it('staff list → Open → profile for that staff member; Back to Staff returns', async () => {
    api.listStaff.mockResolvedValue({ items: [{ id: STAFF_ID, firstName: 'Ada', lastName: 'Lovelace', roleKeys: ['bcba'], status: 'ACTIVE' }], meta: {} });
    mount('/staff'); await settle();
    await click(host.querySelector('.rx-st__name'));
    expect(lastLocation.pathname).toBe(`/staff/${STAFF_ID}`);
    expect(host.querySelector('.rx-sp__name').textContent).toBe('Ada King Lovelace');
    await click(host.querySelector('.rx-sp__back'));
    expect(lastLocation.pathname).toBe('/staff');
  });

  it('the legacy /staff/:id/edit URL opens the editor on the profile', async () => {
    mount(`/staff/${STAFF_ID}/edit`); await settle();
    expect(lastLocation.pathname).toBe(`/staff/${STAFF_ID}`);
    expect(document.querySelector('[role="dialog"]').textContent).toContain('Edit staff member');
  });

  it('not found (404 — including out-of-scope or other-tenant ids) shows a professional state', async () => {
    api.getStaff.mockRejectedValue({ response: { status: 404, data: { error: { code: 'STAFF_NOT_FOUND' } } } });
    mount(); await settle();
    expect(text()).toContain('Staff member not found');
    expect(host.querySelector('.rx-sp__notfound a').getAttribute('href')).toBe('/staff');
    expect(api.getStaff).toHaveBeenCalledTimes(1);
  });

  it('server error shows a retry that reloads', async () => {
    api.getStaff.mockRejectedValueOnce({ response: { status: 500 } });
    mount(); await settle();
    expect(text()).toContain('We couldn’t load this staff member');
    api.getStaff.mockResolvedValue(detail());
    await click(button(/^Retry$/));
    expect(host.querySelector('.rx-sp__name').textContent).toBe('Ada King Lovelace');
  });

  it('loading shows skeletons, not data', async () => {
    api.getStaff.mockReturnValue(new Promise(() => {}));
    mount(); await settle();
    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(host.querySelector('.rx-sp__name')).toBeNull();
  });

  it('layout: max-w-7xl container and responsive breakpoints without fixed widths', () => {
    const css = readFileSync(resolve(here, '../../../styles/redesign.css'), 'utf8');
    const block = css.slice(css.indexOf('STAFF PROFILE'));
    expect(block).toMatch(/\.rx-sp \{ max-width: 80rem; margin: 0 auto; width: 100%;/);
    expect(block).toMatch(/@media \(max-width: 1024px\) \{\s*\.rx-sp__summary \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}\s*\.rx-sp__cols \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(block).toMatch(/@media \(max-width: 640px\)[^]*\.rx-sp__summary \{ grid-template-columns: minmax\(0, 1fr\);/);
    expect(block).not.toMatch(/min-width: (?:[4-9]\d\d|\d{4})px/);
  });
});

describe('tenure helper', () => {
  it('derives tenure from the persisted start date', () => {
    expect(mod.tenureText('2025-06-15', new Date(2026, 8, 14))).toBe('1 yr 2 mo');
    expect(mod.tenureText('2026-09-01', new Date(2026, 8, 14))).toBe('Less than a month');
    expect(mod.tenureText('2027-01-01', new Date(2026, 8, 14))).toBeNull();
    expect(mod.tenureText(null)).toBeNull();
  });
});
