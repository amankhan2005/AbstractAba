import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * ADD CLIENT — step-wise intake over the existing APIs.
 *
 *   1 Client · 2 Parent · 3 Address · 4 Insurance · 5 Authorization
 *
 * Proves: only the current step's fields render; first/middle/last are separate
 * (middle optional); a half-entered parent is blocked; "Create Client" makes ONE
 * client POST + ONE guardian POST with the existing payload shapes; Back after
 * creation updates in place (no second client/guardian); insurance is gated on a
 * valid parent with "Parent details required"; an authorization is saved on
 * "Add Authorization" and listed, with no review/approve step.
 */
const api = {
  createClient: vi.fn(), updateClient: vi.fn(), getClient: vi.fn(),
  addGuardian: vi.fn(), updateGuardian: vi.fn(),
  listServiceAuthorizations: vi.fn(), createServiceAuthorization: vi.fn(),
  fetchCoverage: vi.fn(), createCoverage: vi.fn(), updateCoverage: vi.fn(), removeCoverage: vi.fn(), verifyCoverage: vi.fn(),
  listInsuranceCatalog: vi.fn(),
};
vi.mock('@/api/client', () => Object.fromEntries(Object.keys({
  createClient: 1, updateClient: 1, getClient: 1, addGuardian: 1, updateGuardian: 1,
  listServiceAuthorizations: 1, createServiceAuthorization: 1,
  fetchCoverage: 1, createCoverage: 1, updateCoverage: 1, removeCoverage: 1, verifyCoverage: 1, listInsuranceCatalog: 1,
}).map((k) => [k, (...a) => api[k](...a)])));
vi.mock('@/auth/permissions', () => ({ usePermissions: () => ({ permissions: ['clients.read', 'clients.update'], ready: true, can: () => true }) }));
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useNavigate: () => navigate, useParams: () => ({}) }));

const PARENT = { id: 'g-1', firstName: 'Jane', lastName: 'Smith', phone: '5551234567', email: 'jane@example.com', isPrimary: true };
let guardians; let auths;

let host; let root; let ClientFormPage;
beforeEach(async () => {
  ({ ClientFormPage } = await import('./ClientFormPage.jsx'));
  for (const fn of Object.values(api)) fn.mockReset();
  navigate.mockReset();
  guardians = []; auths = [];
  api.createClient.mockResolvedValue({ id: 'c-9', version: 1 });
  api.updateClient.mockResolvedValue({ id: 'c-9', version: 2 });
  api.getClient.mockImplementation(async () => ({ client: { id: 'c-9', firstName: 'John', lastName: 'Smith', status: 'REFERRED', version: 1 }, guardians }));
  api.addGuardian.mockImplementation(async (_c, body) => { const g = { id: 'g-1', ...body }; guardians = [g]; return g; });
  api.updateGuardian.mockImplementation(async (_c, id, body) => { guardians = [{ id, ...body }]; return guardians[0]; });
  api.listServiceAuthorizations.mockImplementation(async () => auths);
  api.createServiceAuthorization.mockImplementation(async (_c, body) => { const a = { id: `a-${auths.length + 1}`, status: 'NOT_SENT', ...body }; auths = [...auths, a]; return a; });
  api.fetchCoverage.mockResolvedValue({ items: [], status: null });
  api.listInsuranceCatalog.mockResolvedValue([]);
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

const settle = async () => { for (let i = 0; i < 30; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><ToastProvider><MemoryRouter initialEntries={['/clients/new']}><ClientFormPage /></MemoryRouter></ToastProvider></QueryClientProvider>));
};
const input = (label) => document.querySelector(`input[aria-label="${label}"]`);
// Step panels animate in (AnimatePresence mode="wait"): wait for the element.
const waitFor = async (find) => {
  for (let i = 0; i < 200; i += 1) {
    const el = find();
    if (el) return el;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error('element never appeared: ' + document.body.textContent.slice(0, 600));
};
const type = async (label, value) => {
  const el = await waitFor(() => input(label));
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const button = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const click = async (re) => { const b = typeof re === 'object' && re.tagName ? re : await waitFor(() => button(re)); await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); };
const title = () => host.querySelector('.rx-ci__title').textContent;
const current = () => host.querySelector('.rx-ci__step[aria-current="step"] .rx-ci__step-label').textContent;
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;

async function fillClient() { await type('First name', 'john'); await type('Middle name', 'michael'); await type('Last name', 'smith'); }
async function fillParent() {
  await type('Parent first name', 'jane'); await type('Parent last name', 'smith');
  await type('Parent mobile number', '5551234567'); await type('Parent email', 'jane@example.com');
}

describe('Add Client — step-wise intake', () => {
  it('stepper shows the five steps; step 1 has ONLY separate first/middle/last (+ optional DOB)', async () => {
    mount(); await settle();
    expect([...host.querySelectorAll('.rx-ci__step-label')].map((l) => l.textContent)).toEqual(['Client', 'Parent', 'Address', 'Insurance', 'Authorization']);
    expect(current()).toBe('Client');
    expect(title()).toBe('Client Information');
    // Redesigned rail: progress + done/current/todo states.
    expect(host.querySelector('.rx-ci__progress').textContent).toBe('Step 1 of 5');
    expect([...host.querySelectorAll('.rx-ci__step')].map((s) => s.className.replace('rx-ci__step rx-ci__step--', ''))).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(host.querySelector('h1').textContent).toBe('Add Client');
    expect(input('First name')).toBeTruthy();
    expect(input('Middle name')).toBeTruthy();
    expect(input('Last name')).toBeTruthy();
    expect(input('Parent email')).toBeNull();
    expect(input('Address line 1')).toBeNull();
    expect(host.textContent).not.toMatch(/Full name|Status|SSN/);
    expect(button(/^Back$/)).toBeUndefined();
    expect(button(/^Continue$/)).toBeTruthy();
  });

  it('first and last name are required; middle name is optional', async () => {
    mount(); await settle();
    await type('First name', 'john');
    await click(/^Continue$/);
    expect(alertText()).toMatch(/first and last name/);
    expect(current()).toBe('Client');
    await type('Last name', 'smith');
    await click(/^Continue$/);
    expect(current()).toBe('Parent');
    expect(alertText()).toBeNull();
  });

  it('parent step blocks a half-entered parent; Back keeps entered values', async () => {
    mount(); await settle();
    await fillClient(); await click(/^Continue$/);
    expect(title()).toBe('Parent / Guardian Details');
    await type('Parent first name', 'jane');
    await click(/^Continue$/);
    expect(alertText()).toMatch(/first name, last name, mobile number and email/);
    expect(current()).toBe('Parent');
    await click(/^Back$/);
    expect((await waitFor(() => input('First name'))).value).toBe('john');
    expect(api.createClient).not.toHaveBeenCalled();
  });

  it('Create Client (after Address): ONE client POST with separate names + address, ONE primary guardian POST', async () => {
    mount(); await settle();
    await fillClient(); await click(/^Continue$/);
    await fillParent(); await click(/^Continue$/);
    expect(title()).toBe('Address');
    await type('Address line 1', '12 Oak St'); await type('City', 'Austin'); await type('ZIP code', '78701');
    expect(button(/^Create Client$/)).toBeTruthy();
    await click(/^Create Client$/);

    expect(api.createClient).toHaveBeenCalledTimes(1);
    const body = api.createClient.mock.calls[0][0];
    expect(body).toEqual({ firstName: 'John', middleName: 'Michael', lastName: 'Smith', address: { line1: '12 Oak St', city: 'Austin', postalCode: '78701' } });
    expect(body.status).toBeUndefined(); // never ACTIVE at create; server default applies
    expect(api.addGuardian).toHaveBeenCalledTimes(1);
    expect(api.addGuardian).toHaveBeenCalledWith('c-9', { firstName: 'Jane', lastName: 'Smith', phone: '5551234567', email: 'jane@example.com', relationship: 'PARENT', isPrimary: true });
    expect(current()).toBe('Insurance');
    expect(button(/^Cancel$/)).toBeUndefined(); // the client now exists
  });

  it('middle name omitted → not sent', async () => {
    mount(); await settle();
    await type('First name', 'ana'); await type('Last name', 'lee'); await click(/^Continue$/);
    await click(/^Continue$/); // no parent
    await click(/^Create Client$/);
    expect(api.createClient.mock.calls[0][0]).toEqual({ firstName: 'Ana', lastName: 'Lee' });
    expect(api.addGuardian).not.toHaveBeenCalled();
  });

  it('Back after creation updates the SAME client and guardian — no duplicate records', async () => {
    mount(); await settle();
    await fillClient(); await click(/^Continue$/);
    await fillParent(); await click(/^Continue$/);
    await click(/^Create Client$/);
    await click(/^Back$/); // Address
    await click(/^Back$/); // Parent
    await type('Parent mobile number', '5559990000');
    await click(/^Continue$/);
    expect(api.addGuardian).toHaveBeenCalledTimes(1);
    expect(api.updateGuardian).toHaveBeenCalledWith('c-9', 'g-1', expect.objectContaining({ phone: '5559990000' }));
    await type('City', 'Dallas');
    await click(/^Continue$/);
    expect(api.createClient).toHaveBeenCalledTimes(1);
    expect(api.updateClient).toHaveBeenCalledWith('c-9', expect.objectContaining({ address: { city: 'Dallas' } }), 1);
    expect(current()).toBe('Insurance');
  });

  it('insurance WITHOUT a parent: "Parent details required" → Add parent details returns to the Parent step; Cancel closes', async () => {
    mount(); await settle();
    await fillClient(); await click(/^Continue$/);
    await click(/^Continue$/); // skip parent
    await click(/^Create Client$/);
    expect(current()).toBe('Insurance');
    await click(/^Add insurance$/);
    let dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('Parent details required');
    expect(dialog.textContent).toContain('Please add the parent or guardian details before continuing.');
    await click(/^Cancel$/);
    await waitFor(() => (document.querySelector('[role="dialog"]') ? null : true)); // closes (after its exit animation)
    expect(api.createCoverage).not.toHaveBeenCalled();

    await click(/^Add insurance$/);
    dialog = document.querySelector('[role="dialog"]');
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add parent details'));
    expect(current()).toBe('Parent');
    await fillParent(); await click(/^Continue$/); await click(/^Continue$/);
    expect(api.addGuardian).toHaveBeenCalledTimes(1);
    // With a valid parent on file, the client's existing insurance panel is used.
    expect(current()).toBe('Insurance');
    await waitFor(() => (/No insurance recorded/.test(host.textContent) ? true : null));
    expect(host.textContent).toContain('No insurance recorded');
    expect(host.querySelector('.rx-ci__gate')).toBeNull(); // the gated placeholder is gone
    expect(document.body.textContent).not.toContain('Parent details required');
  });

  it('authorization WITHOUT a parent: "Parent details required" (nothing saved) → Add parent details → then Add Authorization works', async () => {
    mount(); await settle();
    await fillClient(); await click(/^Continue$/);
    await click(/^Continue$/); // skip parent
    await click(/^Create Client$/);
    await click(/^Continue$/); // Insurance → Authorization
    expect(title()).toBe('Authorization');
    expect(input('Authorization number')).toBeNull(); // no form that cannot be saved
    await click(/^Add authorization$/);
    let dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('Parent details required');
    expect(dialog.textContent).toContain('Please add the parent or guardian details before continuing.');
    await click(/^Cancel$/);
    await waitFor(() => (document.querySelector('[role="dialog"]') ? null : true));
    expect(current()).toBe('Authorization');
    expect(api.createServiceAuthorization).not.toHaveBeenCalled();
    expect(api.createClient).toHaveBeenCalledTimes(1); // the client is kept, never deleted

    await click(/^Add authorization$/);
    dialog = document.querySelector('[role="dialog"]');
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add parent details'));
    expect(current()).toBe('Parent');
    await fillParent();
    await click(/^Continue$/); await click(/^Continue$/); await click(/^Continue$/); // Parent → Address → Insurance → Authorization
    expect(api.addGuardian).toHaveBeenCalledTimes(1);
    expect(title()).toBe('Authorization');
    await type('Authorization number', 'AUTH-88');
    await click(/^Add Authorization$/);
    expect(api.createServiceAuthorization).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[aria-label="Authorizations"]').textContent).toContain('ABA · #AUTH-88');
  });

  it('authorization: Add Authorization saves immediately and lists it — no review/approve step; Finish opens the client', async () => {
    mount(); await settle();
    await fillClient(); await click(/^Continue$/);
    await fillParent(); await click(/^Continue$/);
    await click(/^Create Client$/);
    // Parent entered BEFORE the client existed: the steps must see it on file
    // (regression — a detail fetch racing the guardian save left it stale).
    expect(current()).toBe('Insurance');
    await waitFor(() => (/Add insurance from your state catalog|No insurance recorded/.test(host.textContent) ? true : null));
    expect(host.querySelector('.rx-ci__gate')).toBeNull();
    await click(/^Continue$/); // Insurance → Authorization
    expect(title()).toBe('Authorization');
    await type('Authorization number', 'AUTH-77');
    await type('Units', '120');
    await click(/^Add Authorization$/);
    expect(api.createServiceAuthorization).toHaveBeenCalledTimes(1);
    expect(api.createServiceAuthorization).toHaveBeenCalledWith('c-9', expect.objectContaining({ serviceType: 'ABA', authorizationNumber: 'AUTH-77', units: 120 }));
    const list = host.querySelector('[aria-label="Authorizations"]');
    expect(list.textContent).toContain('ABA · #AUTH-77');
    expect(list.textContent).toContain('120 units');
    expect(input('Authorization number').value).toBe(''); // form reset for the next one
    expect(document.body.textContent).not.toMatch(/Review & approve|Mark sent|Approve\b/);
    await click(/^Finish$/);
    expect(navigate).toHaveBeenCalledWith('/clients/c-9');
  });

  it('shows the server message on a failed create (e.g. ORG_NOT_ACTIVE) and stays on the step; generic fallback otherwise', async () => {
    api.createClient.mockRejectedValueOnce({ response: { status: 409, data: { error: { code: 'ORG_NOT_ACTIVE', message: 'Clinical records can only be created while the organization is active.' } } } });
    mount(); await settle();
    await fillClient(); await click(/^Continue$/); await click(/^Continue$/);
    await click(/^Create Client$/);
    expect(alertText()).toBe('Clinical records can only be created while the organization is active.');
    expect(current()).toBe('Address');
    api.createClient.mockRejectedValueOnce({ response: { status: 500 } });
    await click(/^Create Client$/);
    expect(alertText()).toBe('Could not save. Check the details and try again.');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a parent save that fails right after creation is retried without creating a second client', async () => {
    api.addGuardian.mockRejectedValueOnce({ response: { status: 500 } });
    mount(); await settle();
    await fillClient(); await click(/^Continue$/);
    await fillParent(); await click(/^Continue$/);
    await click(/^Create Client$/);
    expect(alertText()).toMatch(/Could not save/);
    await click(/^Continue$/); // retry
    expect(api.createClient).toHaveBeenCalledTimes(1);
    expect(api.addGuardian).toHaveBeenCalledTimes(2);
    expect(current()).toBe('Insurance');
  });
});
