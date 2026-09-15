// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Spec Module 5.1-5.5 — the Super Admin insurance catalog page. Renders the
 * catalog, opens the editor, and submits a create with name + selected states.
 * The query hooks are mocked; the API-side CRUD/validation is covered by the API
 * suite. act()-clean: warnings fail the suite.
 */
const createMut = { mutateAsync: vi.fn().mockResolvedValue({ id: 'ic-9' }), isPending: false };
const updateMut = { mutateAsync: vi.fn(), isPending: false };
const deleteMut = { mutateAsync: vi.fn(), isPending: false };
const uploadMut = { mutateAsync: vi.fn().mockResolvedValue({ id: 'ic-9', logoUrl: 'https://cdn/x.png' }), isPending: false };
let catalogData = [];

vi.mock('@/api/queries', () => ({
  useInsuranceCatalog: () => ({ data: catalogData, isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateInsuranceCatalog: () => createMut,
  useUpdateInsuranceCatalog: () => updateMut,
  useDeleteInsuranceCatalog: () => deleteMut,
  useUploadInsuranceCatalogLogo: () => uploadMut,
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let InsuranceCatalogRx; let ToastProvider;

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ InsuranceCatalogRx } = await import('./InsuranceCatalogRx.jsx'));
  ({ ToastProvider } = await import('@/components'));
  createMut.mutateAsync.mockClear();
  catalogData = [];
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<ToastProvider><InsuranceCatalogRx /></ToastProvider>));
};
const btn = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };
const setInput = (label, value) => {
  const span = [...document.querySelectorAll('label span')].find((s) => s.textContent === label);
  const input = span.parentElement.querySelector('input');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
};

describe('InsuranceCatalogRx — Module 5 Super Admin', () => {
  it('shows an empty state and an Add action', () => {
    catalogData = [];
    mount();
    expect(host.textContent).toMatch(/No insurance companies in the catalog/i);
    expect(btn(/Add insurance/)).toBeTruthy();
  });

  it('lists catalog entries with their states', () => {
    catalogData = [{ id: 'ic-1', name: 'CA Health', states: ['CA', 'NV'], active: true, logoUrl: null }];
    mount();
    expect(host.textContent).toMatch(/CA Health/);
    expect(host.textContent).toMatch(/California, Nevada/);
    expect(btn(/Edit/)).toBeTruthy();
    expect(btn(/Delete/)).toBeTruthy();
  });

  it('creates an entry with a name and selected states', async () => {
    catalogData = [];
    mount();
    await click(btn(/Add insurance/));
    setInput('Name', 'Golden State');
    // pick a state checkbox
    const ca = document.querySelector('input[aria-label="California"]');
    await click(ca);
    await click(btn(/^Save$/));
    expect(createMut.mutateAsync).toHaveBeenCalledTimes(1);
    const body = createMut.mutateAsync.mock.calls[0][0];
    expect(body.name).toBe('Golden State');
    expect(body.states).toContain('CA');
  });

  it('rejects a save with no name (inline error, no request)', async () => {
    catalogData = [];
    mount();
    await click(btn(/Add insurance/));
    await click(btn(/^Save$/));
    expect(createMut.mutateAsync).not.toHaveBeenCalled();
    expect(document.querySelector('.form-error')).toBeTruthy();
  });
});
