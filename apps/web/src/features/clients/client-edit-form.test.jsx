import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Edit Client — redesigned form on the existing API.
 *   - sections + navigation, values loaded from getClient;
 *   - inline validation (mirrors the server) blocks the request;
 *   - Save sends the same versioned update, updates the cached client at once,
 *     invalidates client/roster/alerts and returns to the profile (no reload);
 *   - a version conflict offers "Load latest version" (refetch, not a page reload);
 *   - unsaved changes are guarded.
 * Any React act() warning fails the test.
 */
const api = vi.hoisted(() => ({ getClient: vi.fn(), updateClient: vi.fn(), addGuardian: vi.fn(), updateGuardian: vi.fn() }));
vi.mock('@/api/client', () => Object.fromEntries(Object.keys(api).map((k) => [k, (...a) => api[k](...a)])));

const DETAIL = () => ({
  client: { id: 'c-1', clientNumber: 'CL-0007', firstName: 'Mia', lastName: 'Khan', middleName: '', preferredName: 'Mimi', dateOfBirth: '2019-04-02',
    email: 'mia@example.com', phone: '5551110000', status: 'INTAKE', accountStatus: 'ACTIVE', version: 4, address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' } },
  guardians: [{ id: 'g-1', firstName: 'Sarah', lastName: 'Khan', relationship: 'PARENT', isPrimary: true, phone: '5551234567', email: 'sarah@example.com' }],
});

let consoleErrorSpy; let host; let root; let qc; let lastLocation; let ClientFormPage;
function Probe() { lastLocation = useLocation(); return null; }

beforeEach(async () => {
  ({ ClientFormPage } = await import('./ClientFormPage.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  for (const fn of Object.values(api)) fn.mockReset();
  api.getClient.mockResolvedValue(DETAIL());
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove(); document.body.innerHTML = '';
  root = undefined; host = undefined;
  const w = consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
  consoleErrorSpy.mockRestore();
  expect(w).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(qc, 'invalidateQueries');
  act(() => root.render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/clients/c-1/edit']}>
        <Probe />
        <Routes>
          <Route path="/clients/:clientId/edit" element={<ClientFormPage />} />
          <Route path="/clients/:clientId" element={<div>profile</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
};
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const control = (label) => [...host.querySelectorAll('label > span.rx-ce__label')].find((s) => s.textContent === label)?.parentElement.querySelector('input, select');
const fieldError = (label) => control(label)?.closest('label').querySelector('.rx-ce__err')?.textContent ?? null;
const setValue = async (label, value) => {
  const el = control(label);
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
};
const button = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }); await settle(); };
const submit = async () => { await click(button(/^Save Changes$/)); };

describe('Edit Client — redesigned form', () => {
  it('renders the header, section navigation and the loaded values', async () => {
    mount(); await settle();
    expect(host.querySelector('h1').textContent).toBe('Edit Client');
    expect(host.querySelector('.rx-ce__subtitle').textContent).toContain('Mia Khan');
    expect(host.querySelector('.rx-ce__subtitle').textContent).toContain('Client #CL-0007');
    expect([...host.querySelectorAll('.rx-ce__nav-label')].map((n) => n.textContent)).toEqual(['Client details', 'Contact & status', 'Address', 'Parent / Guardian']);
    expect([...host.querySelectorAll('.rx-ce__section-title')].map((n) => n.textContent)).toEqual(['Client details', 'Contact & status', 'Address', 'Parent / Guardian']);
    expect(control('First name').value).toBe('Mia');
    expect(control('Preferred name').value).toBe('Mimi');
    expect(control('Status').value).toBe('INTAKE');
    expect([...control('Status').options].map((o) => o.textContent)).toEqual(['Referred', 'Intake', 'Active', 'On hold', 'Discharged']);
    expect(control('City').value).toBe('Austin');
    expect(control('Parent email').value).toBe('sarah@example.com');
    expect(host.querySelector('.rx-ce__pill--ok').textContent).toContain('Valid parent');
    expect(host.querySelector('.rx-ce__save-state').textContent).toBe('No changes yet');
    // SSN is masked (not a password field, so browsers never autofill a login password into it)
    expect(control('SSN').type).toBe('text');
    expect(control('SSN').className).toContain('rx-ce__control--masked');
  });

  it('inline validation marks the fields and sends nothing', async () => {
    mount(); await settle();
    await setValue('First name', '  ');
    await setValue('Email', 'not-an-email');
    await setValue('Parent mobile number', '');
    expect(host.querySelector('.rx-ce__save-state').textContent).toBe('Unsaved changes');
    await submit();
    expect(fieldError('First name')).toBe('First name is required.');
    expect(fieldError('Email')).toBe('Enter a valid email address.');
    expect(fieldError('Parent mobile number')).toBe('Required for a parent.');
    expect(host.querySelector('.form-error').textContent).toMatch(/name, mobile number and email/);
    expect(host.querySelectorAll('.rx-ce__nav-flag--error')).toHaveLength(3);
    expect(api.updateClient).not.toHaveBeenCalled();
    // fixing a field clears its error
    await setValue('First name', 'Mia');
    expect(fieldError('First name')).toBeNull();
  });

  it('Save persists through the existing API, updates the cache immediately, invalidates dependents and returns to the profile', async () => {
    api.updateClient.mockResolvedValue({ ...DETAIL().client, preferredName: 'Mimi K', version: 5 });
    api.updateGuardian.mockResolvedValue({ ...DETAIL().guardians[0], phone: '5559998888' });
    mount(); await settle();
    await setValue('Preferred name', 'Mimi K');
    await setValue('Parent mobile number', '5559998888');
    api.getClient.mockImplementation(() => new Promise(() => {})); // the refetch never returns: the cache must already hold the saved values
    await submit();

    expect(api.updateClient).toHaveBeenCalledTimes(1);
    const [id, body, version] = api.updateClient.mock.calls[0];
    expect(id).toBe('c-1');
    expect(version).toBe(4);
    expect(body).toMatchObject({ firstName: 'Mia', lastName: 'Khan', preferredName: 'Mimi K', status: 'INTAKE', address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' } });
    expect(body).not.toHaveProperty('tenantId');
    expect(api.updateGuardian).toHaveBeenCalledWith('c-1', 'g-1', expect.objectContaining({ phone: '5559998888' }));
    expect(api.addGuardian).not.toHaveBeenCalled();

    const cached = qc.getQueryData(['client', 'c-1']);
    expect(cached.client.preferredName).toBe('Mimi K');
    expect(cached.guardians[0].phone).toBe('5559998888');
    const keys = qc.invalidateQueries.mock.calls.map(([f]) => JSON.stringify(f.queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["clients"]', '["client","c-1"]', '["child-alerts","c-1"]']));
    expect(lastLocation.pathname).toBe('/clients/c-1');
  });

  it('a version conflict offers Load latest version, which refetches and reloads the form values (no page reload)', async () => {
    api.updateClient.mockRejectedValue({ response: { status: 409, data: { error: { code: 'VERSION_CONFLICT', message: 'stale' } } } });
    mount(); await settle();
    await setValue('Preferred name', 'Mine');
    await submit();
    expect(host.querySelector('.form-error').textContent).toBe('This client changed since you loaded it. Reload and try again.');
    const latest = DETAIL(); latest.client.preferredName = 'Theirs'; latest.client.version = 9;
    api.getClient.mockResolvedValue(latest);
    await click(button(/^Load latest version$/));
    expect(control('Preferred name').value).toBe('Theirs');
    expect(host.querySelector('.form-error')).toBeNull();
    api.updateClient.mockResolvedValue({ ...latest.client, version: 10 });
    await submit();
    expect(api.updateClient.mock.calls.at(-1)[2]).toBe(9);
  });

  it('server field errors are shown on the fields', async () => {
    api.updateClient.mockRejectedValue({ response: { status: 422, data: { error: { code: 'VALIDATION_FAILED', details: { fieldErrors: { phone: ['String must contain at least 3 character(s)'] } } } } } });
    mount(); await settle();
    await submit();
    expect(fieldError('Phone')).toBe('String must contain at least 3 character(s)');
  });

  it('Cancel with unsaved changes asks before leaving; without changes it leaves straight away', async () => {
    mount(); await settle();
    await setValue('City', 'Dallas');
    await click(button(/^Cancel$/));
    expect(document.querySelector('[role="dialog"]').textContent).toContain('Discard changes?');
    expect(lastLocation.pathname).toBe('/clients/c-1/edit');
    await click(button(/^Discard changes$/));
    expect(lastLocation.pathname).toBe('/clients/c-1');
    expect(api.updateClient).not.toHaveBeenCalled();
  });

  it('not found shows a clear state', async () => {
    api.getClient.mockRejectedValue({ response: { status: 404 } });
    mount(); await settle();
    expect(host.textContent).toContain('Client not found');
    expect(host.querySelector('form')).toBeNull();
  });
});
