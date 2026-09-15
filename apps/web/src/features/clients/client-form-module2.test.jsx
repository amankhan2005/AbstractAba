import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Spec Module 2 — the Add Client form: Client Information + Address + Parent,
 * name capitalization on save, structured address, a valid-parent added in the
 * same flow, a half-entered parent blocked, ACTIVE not offered at create, and a
 * friendly activation message (never the raw code).
 */
const createClient = vi.fn();
const updateClient = vi.fn();
const getClient = vi.fn();
const addGuardian = vi.fn();
const navigate = vi.fn();

vi.mock('@/api/client', () => ({
  createClient: (...a) => createClient(...a),
  updateClient: (...a) => updateClient(...a),
  getClient: (...a) => getClient(...a),
  addGuardian: (...a) => addGuardian(...a),
}));

let currentPath = '/clients/new';
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigate, useParams: () => (currentPath.includes('/edit') ? { clientId: 'c-1' } : {}) };
});

let ClientFormPage;
beforeEach(async () => {
  ({ ClientFormPage } = await import('./ClientFormPage.jsx'));
  createClient.mockReset(); updateClient.mockReset(); getClient.mockReset(); addGuardian.mockReset(); navigate.mockReset();
});

let host; let root;
const mount = () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[currentPath]}><ClientFormPage /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
};
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const field = (label) => {
  const span = [...host.querySelectorAll('label span')].find((s) => s.textContent === label);
  return span ? span.parentElement.querySelector('input, select') : null;
};
const setInput = (label, value) => {
  const input = field(label);
  const proto = input.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
  act(() => input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })));
};
const submit = async () => {
  const form = host.querySelector('form');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
  // let an async create/update (incl. a rejected mutation) settle and re-render
  await flush();
  await flush();
};
const errorText = () => host.querySelector('.form-error')?.textContent ?? null;

// Flush real macrotasks (not just microtasks): React Query commits async query
// results on a scheduler tick, so waiting on Promise.resolve() alone is racy
// under parallel CPU load. Poll the DOM on setTimeout(0) until the field appears.
const flush = async () => { await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); }); };
const waitForField = async (label) => {
  for (let i = 0; i < 100; i += 1) { if (field(label)) return; await flush(); } // eslint-disable-line no-await-in-loop
  throw new Error(`field "${label}" never rendered`);
};

describe('Edit Client form — Module 2', () => {
  // Add Client (create) is the step-wise intake — covered by client-intake-wizard.test.jsx.
  it('shows a friendly activation message for CLIENT_ACTIVATION_REQUIRES_PARENT (edit)', async () => {
    currentPath = '/clients/c-1/edit';
    getClient.mockResolvedValue({ client: { id: 'c-1', firstName: 'John', lastName: 'Smith', status: 'REFERRED', version: 2 } });
    updateClient.mockRejectedValue({ response: { status: 409, data: { error: { code: 'CLIENT_ACTIVATION_REQUIRES_PARENT', message: 'raw code text' } } } });
    mount();
    // wait for the edit load to render the form (macrotask-safe under load)
    await waitForField('Status');
    setInput('Status', 'ACTIVE');
    await submit();
    expect(errorText()).toMatch(/Add at least one parent/i);
    expect(errorText()).not.toMatch(/raw code text/);
    expect(navigate).not.toHaveBeenCalled();
  });
});
