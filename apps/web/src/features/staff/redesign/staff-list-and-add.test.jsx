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
 * Company Admin Staff list + Add Staff form. The list renders GET /v1/staff
 * (search, status, cursor pagination); the form posts the existing
 * POST /v1/staff body and shows the server's errors. No Title field.
 */
const api = { listStaff: vi.fn(), createStaff: vi.fn(), getStaff: vi.fn() };
vi.mock('@/api/client', () => ({
  listStaff: (...a) => api.listStaff(...a),
  createStaff: (...a) => api.createStaff(...a),
  getStaff: (...a) => api.getStaff(...a),
}));
let permissions = [];
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ status: 'authenticated', principal: { permissions } }),
  useOrgTimezone: () => 'America/New_York',
}));

const here = dirname(fileURLToPath(import.meta.url));
const ADA = { id: 's-ada', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@clinic.com', roleKeys: ['bcba'], title: 'Lead BCBA', employeeNumber: 'EMP-0001', startDate: '2026-02-01', status: 'ACTIVE' };
const NIA = { id: 's-nia', firstName: 'Nia', lastName: 'Patel', email: 'nia@clinic.com', roleKeys: ['rbt'], title: null, employeeNumber: 'EMP-0002', startDate: null, status: 'INACTIVE' };
const page = (items, nextCursor = null) => ({ items, meta: { nextCursor, limit: 25 } });

let host; let root; let List; let Form; let lastLocation;
function Probe() { lastLocation = useLocation(); return null; }

beforeEach(async () => {
  permissions = ['staff.read', 'staff.manage'];
  for (const fn of Object.values(api)) fn.mockReset();
  api.listStaff.mockResolvedValue(page([ADA, NIA]));
  ({ StaffListRedesign: List } = await import('./StaffListRedesign.jsx'));
  ({ AddStaffForm: Form } = await import('./AddStaffForm.jsx'));
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; vi.useRealTimers(); });

const mount = (path = '/staff') => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Probe />
        <Routes>
          <Route path="/staff" element={<List />} />
          <Route path="/staff/new" element={<Form />} />
          <Route path="/staff/:staffId" element={<div>profile page</div>} />
          <Route path="/staff/:staffId/edit" element={<div>edit page</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  ));
};
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const text = () => document.body.textContent;
const button = (re, scope = document) => [...scope.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); }); await settle(); };
const type = async (el, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const rows = () => [...host.querySelectorAll('.rx-st__row')];
const fieldError = (label) => [...document.querySelectorAll('.rx-formfield')].find((f) => f.querySelector('label')?.textContent.startsWith(label))?.querySelector('.rx-formfield__err')?.textContent?.trim() ?? null;

describe('Staff list', () => {
  it('renders the real staff records: name, email, role, title, employee ID, start date and status', async () => {
    mount(); await settle();
    expect(api.listStaff).toHaveBeenCalledWith({ limit: 25 });
    expect(host.querySelector('.rx-st__title').textContent).toBe('Staff');
    const [ada, nia] = rows();
    expect(ada.querySelector('.rx-st__name').textContent).toBe('Ada Lovelace');
    expect(ada.querySelector('.rx-st__sub').textContent).toContain('ada@clinic.com');
    expect(ada.querySelector('.rx-st__sub').textContent).toContain('Lead BCBA');
    expect(ada.querySelector('.rx-st__role').textContent).toBe('BCBA');
    expect(ada.querySelector('.rx-st__avatar').className).toContain('rx-st__avatar--bcba');
    expect([...ada.querySelectorAll('.rx-st__cell')].map((c) => c.textContent)).toEqual(['BCBA', 'EMP-0001', '02/01/2026', 'Active']);
    expect([...nia.querySelectorAll('.rx-st__cell')].map((c) => c.textContent)).toEqual(['RBT', 'EMP-0002', '—', 'Inactive']);
    expect(text()).toContain('Showing 2 staff members');
  });

  it('search is sent to the API after typing pauses; the status filter is sent as status', async () => {
    mount(); await settle();
    await type(host.querySelector('input[type="search"]'), 'ada');
    await act(async () => { await new Promise((r) => setTimeout(r, 350)); });
    await settle();
    expect(api.listStaff).toHaveBeenLastCalledWith({ limit: 25, search: 'ada' });
    await click(button(/^Inactive$/));
    expect(api.listStaff).toHaveBeenLastCalledWith({ limit: 25, search: 'ada', status: 'INACTIVE' });
    expect(button(/^Inactive$/).getAttribute('aria-checked')).toBe('true');
  });

  it('no matches → a search empty state that clears the filters', async () => {
    mount(); await settle();
    api.listStaff.mockResolvedValue(page([]));
    await click(button(/^Active$/));
    expect(text()).toContain('No staff match your search');
    api.listStaff.mockResolvedValue(page([ADA, NIA]));
    await click(button(/^Clear filters$/));
    expect(api.listStaff).toHaveBeenLastCalledWith({ limit: 25 });
    expect(rows()).toHaveLength(2);
  });

  it('empty organization → "No staff yet" with Add staff for managers', async () => {
    api.listStaff.mockResolvedValue(page([]));
    mount(); await settle();
    expect(text()).toContain('No staff yet');
    expect(host.querySelectorAll('.rx-st__empty button')).toHaveLength(1);
  });

  it('Load more requests the next cursor page and appends rows', async () => {
    api.listStaff.mockResolvedValueOnce(page([ADA], 'cursor-1')).mockResolvedValueOnce(page([NIA]));
    mount(); await settle();
    expect(rows()).toHaveLength(1);
    expect(text()).toContain('more available');
    await click(button(/^Load more$/));
    expect(api.listStaff).toHaveBeenLastCalledWith({ limit: 25, cursor: 'cursor-1' });
    expect(rows().map((r) => r.querySelector('.rx-st__name').textContent)).toEqual(['Ada Lovelace', 'Nia Patel']);
    expect(button(/^Load more$/)).toBeUndefined();
  });

  it('opening a row goes to the profile; Edit goes to the existing edit route', async () => {
    mount(); await settle();
    await click(rows()[1]);
    expect(lastLocation.pathname).toBe('/staff/s-nia');
  });

  it('Edit action and Add staff are shown only with staff.manage', async () => {
    mount(); await settle();
    expect(rows()[0].querySelector('a[aria-label="Edit Ada Lovelace"]').getAttribute('href')).toBe('/staff/s-ada/edit');
    expect(button(/^Add staff$/)).toBeTruthy();
    act(() => root.unmount()); host.remove(); root = undefined;
    permissions = ['staff.read'];
    mount(); await settle();
    expect(host.querySelector('a[aria-label="Edit Ada Lovelace"]')).toBeNull();
    expect(button(/^Add staff$/)).toBeUndefined();
    expect(rows()[0].querySelector('a[aria-label="Open Ada Lovelace"]')).toBeTruthy();
  });

  it('loading shows skeleton rows; an API error shows a retry', async () => {
    api.listStaff.mockReturnValueOnce(new Promise(() => {}));
    mount(); await settle();
    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy();
    act(() => root.unmount()); host.remove(); root = undefined;
    api.listStaff.mockRejectedValueOnce({ response: { status: 500 } });
    mount(); await settle();
    expect(text()).toContain('We couldn’t load your staff');
    await click(button(/^Retry$/));
    expect(rows()).toHaveLength(2);
  });
});

describe('Add Staff form', () => {
  it('has Role, Personal information and Employment details — and NO Title or Status field', async () => {
    mount('/staff/new'); await settle();
    expect(host.querySelector('.rx-sf__title').textContent).toBe('Add staff member');
    expect([...host.querySelectorAll('.rx-sf__section-title')].map((t) => t.textContent)).toEqual(['Role*', 'Personal information', 'Employment details']);
    const labels = [...host.querySelectorAll('.rx-formfield label')].map((l) => l.textContent);
    expect(labels).toEqual(['First name*', 'Middle name', 'Last name*', 'Work email*', 'Start date', 'Hourly pay rate']);
    expect(text()).not.toMatch(/\bTitle\b|Job title|Professional title/);
    expect(labels.some((l) => /Status/.test(l))).toBe(false);
    const source = readFileSync(resolve(here, 'AddStaffForm.jsx'), 'utf8');
    expect(source).not.toMatch(/\btitle:|set\('title'\)|label="Title"/);
  });

  it('required fields validate inline and nothing is posted', async () => {
    mount('/staff/new'); await settle();
    await click(button(/^Create staff member$/));
    expect(api.createStaff).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]').textContent).toContain('Please complete the required fields.');
    expect(host.querySelector('.rx-sf__err').textContent).toBe('Choose a role.');
    expect(fieldError('First name')).toBe('First name is required.');
    expect(fieldError('Last name')).toBe('Last name is required.');
    expect(fieldError('Work email')).toBe('Email is required — the login invitation is sent here.');
    // Fixing a field clears its error.
    await type(document.getElementById('sf-first'), 'Ada');
    expect(fieldError('First name')).toBeNull();
    await type(document.getElementById('sf-email'), 'not-an-email');
    await type(document.getElementById('sf-rate'), '20000');
    await click(button(/^Create staff member$/));
    expect(fieldError('Work email')).toBe('Enter a valid email address.');
    expect(fieldError('Hourly pay rate')).toBe('Enter an hourly rate between 0 and 10,000.');
    expect(api.createStaff).not.toHaveBeenCalled();
  });

  const fillValid = async () => {
    await click(host.querySelector('.rx-sf__role--rbt'));
    await type(document.getElementById('sf-first'), '  nia ');
    await type(document.getElementById('sf-middle'), 'Rose');
    await type(document.getElementById('sf-last'), 'Patel');
    await type(document.getElementById('sf-email'), 'Nia@Clinic.com');
    await type(document.getElementById('sf-rate'), '28.5');
  };

  it('creates through the existing API with exactly the accepted fields, shows success, and the Staff list refreshes without a reload', async () => {
    api.listStaff.mockResolvedValue(page([ADA]));
    mount('/staff'); await settle();
    expect(rows()).toHaveLength(1);
    await click(button(/^Add staff$/));
    expect(lastLocation.pathname).toBe('/staff/new');
    await fillValid();
    expect(host.querySelector('.rx-sf__role--rbt').getAttribute('aria-checked')).toBe('true');
    api.createStaff.mockResolvedValue({ id: 's-nia', employeeNumber: 'EMP-0002', emailQueued: true });
    api.listStaff.mockResolvedValue(page([ADA, NIA]));
    await click(button(/^Create staff member$/));

    expect(api.createStaff).toHaveBeenCalledTimes(1);
    expect(api.createStaff).toHaveBeenCalledWith({ roleKey: 'rbt', firstName: 'nia', middleName: 'Rose', lastName: 'Patel', email: 'nia@clinic.com', hourlyPayRate: 28.5 });
    const success = host.querySelector('[role="status"]');
    expect(success.textContent).toContain('Nia Rose Patel has been added');
    expect(success.textContent).toContain('RBT account created · Employee ID EMP-0002.');
    expect(success.textContent).toContain('Login instructions are on their way to nia@clinic.com.');
    expect(text()).toContain('Staff member created.');

    await click(button(/^Back to Staff$/));
    expect(lastLocation.pathname).toBe('/staff');
    expect(rows().map((r) => r.querySelector('.rx-st__name').textContent)).toEqual(['Ada Lovelace', 'Nia Patel']);
  });

  it('success: View profile opens the new staff member; Add another resets the form', async () => {
    mount('/staff/new'); await settle();
    await fillValid();
    api.createStaff.mockResolvedValue({ id: 's-nia', emailQueued: false });
    await click(button(/^Create staff member$/));
    expect(text()).toContain('The login email could not be queued.');
    await click(button(/^Add another$/));
    expect(document.getElementById('sf-first').value).toBe('');
    expect(host.querySelector('.rx-sf__role.is-selected')).toBeNull();
    await fillValid();
    api.createStaff.mockResolvedValue({ id: 's-new', emailQueued: true });
    await click(button(/^Create staff member$/));
    await click(button(/^View profile$/));
    expect(lastLocation.pathname).toBe('/staff/s-new');
  });

  it('duplicate email (409) keeps the form and shows the server message on the email field', async () => {
    mount('/staff/new'); await settle();
    await fillValid();
    api.createStaff.mockRejectedValue({ response: { status: 409, data: { error: { code: 'DUPLICATE_STAFF_EMAIL', message: 'An account already exists for that email address.' } } } });
    await click(button(/^Create staff member$/));
    expect(fieldError('Work email')).toBe('An account already exists for that email address.');
    expect(document.getElementById('sf-last').value).toBe('Patel');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('server validation (422 fieldErrors) is mapped inline; other failures show the server message', async () => {
    mount('/staff/new'); await settle();
    await fillValid();
    api.createStaff.mockRejectedValueOnce({ response: { status: 422, data: { error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', details: { formErrors: [], fieldErrors: { email: ['Invalid email'], hourlyPayRate: ['Number must be less than or equal to 10000'] } } } } } });
    await click(button(/^Create staff member$/));
    expect(fieldError('Work email')).toBe('Invalid email');
    expect(fieldError('Hourly pay rate')).toBe('Number must be less than or equal to 10000');
    expect(host.querySelector('[role="alert"]').textContent).toContain('Please correct the highlighted fields.');
    api.createStaff.mockRejectedValueOnce({ response: { status: 409, data: { error: { code: 'ORG_NOT_ACTIVE', message: 'Clinical records can only be created while the organization is active.' } } } });
    await click(button(/^Create staff member$/));
    api.createStaff.mockRejectedValueOnce({ response: { status: 500, data: { error: { code: 'GEN-500', message: 'GEN-500' } } } });
    await click(button(/^Create staff member$/));
    expect(host.querySelector('[role="alert"]').textContent).toContain('The staff member could not be created. Please try again.');
  });

  it('while submitting: one POST, button disabled with a loading label', async () => {
    mount('/staff/new'); await settle();
    await fillValid();
    let resolve; api.createStaff.mockReturnValue(new Promise((r) => { resolve = r; }));
    const submit = button(/^Create staff member$/);
    await act(async () => { submit.click(); submit.click(); });
    await settle(5);
    expect(api.createStaff).toHaveBeenCalledTimes(1);
    const busy = button(/Creating/);
    expect(busy.disabled).toBe(true);
    await act(async () => { resolve({ id: 's-x', emailQueued: true }); });
    await settle();
    expect(host.querySelector('[role="status"]')).toBeTruthy();
  });

  it('Cancel returns to the Staff list; without staff.manage the form is not offered', async () => {
    mount('/staff/new'); await settle();
    await click(button(/^Cancel$/));
    expect(lastLocation.pathname).toBe('/staff');
    act(() => root.unmount()); host.remove(); root = undefined;
    permissions = ['staff.read'];
    mount('/staff/new'); await settle();
    expect(text()).toContain('You can’t add staff');
    expect(host.querySelector('form')).toBeNull();
  });
});

describe('table column alignment', () => {
  it('the header and every row use ONE shared column definition; Actions has its own header', async () => {
    mount(); await settle();
    const css = readFileSync(resolve(here, '../../../styles/redesign.css'), 'utf8');
    const list = css.slice(css.indexOf('STAFF LIST'), css.indexOf('ADD STAFF FORM'));
    expect(list).toMatch(/\.rx-st__listhead, \.rx-st__row \{ display: grid; grid-template-columns: var\(--st-cols\); column-gap: var\(--st-gap\);/);
    // Exactly one base definition; every track can shrink (minmax(0, …)) except the fixed Actions track.
    expect(list.match(/--st-cols:/g)).toHaveLength(2); // desktop + ≤1200px tuning, both on the shared variable
    expect(list).toMatch(/--st-cols: minmax\(0, 2\.4fr\) minmax\(0, 1fr\) minmax\(0, 1\.1fr\) minmax\(0, 1fr\) minmax\(0, 0\.9fr\) 148px;/);
    expect(list).not.toMatch(/\.rx-st__row \{[^}]*grid-template-columns: minmax/);
    // Header cells match the row cell count, in order.
    expect([...host.querySelectorAll('.rx-st__listhead > span')].map((s) => s.textContent)).toEqual(['Staff member', 'Role', 'Employee ID', 'Start date', 'Status', 'Actions']);
    for (const row of rows()) expect(row.children).toHaveLength(6);
  });
});

describe('responsive layout', () => {
  it('both pages use the max-w-7xl container with tablet and mobile breakpoints', () => {
    const css = readFileSync(resolve(here, '../../../styles/redesign.css'), 'utf8');
    const list = css.slice(css.indexOf('STAFF LIST'), css.indexOf('ADD STAFF FORM'));
    const form = css.slice(css.indexOf('ADD STAFF FORM'));
    expect(list).toMatch(/\.rx-st \{ max-width: 80rem;/);
    expect(list).toMatch(/@media \(max-width: 900px\) \{\s*\.rx-st__listhead \{ display: none; \}/);
    expect(list).toMatch(/@media \(max-width: 560px\)/);
    expect(form).toMatch(/\.rx-sf \{ max-width: 80rem;/);
    expect(form).toMatch(/@media \(max-width: 1024px\) \{\s*\.rx-sf__layout \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(form).toMatch(/@media \(max-width: 640px\)[^]*\.rx-sf__grid, \.rx-sf__roles \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(css).not.toMatch(/rx-rolecard/);
  });
});
