import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Add Client and Edit Client DOB use the masked MM/DD/YYYY control — the visible
 * editable field shows MM/DD/YYYY (not dd/mm/yyyy, not a native date input), and
 * an existing stored 2015-08-27 appears as 08/27/2015.
 */

const getClient = vi.fn();
vi.mock('@/api/client', () => ({
  getClient: (...a) => getClient(...a),
  createClient: vi.fn(), updateClient: vi.fn(), addGuardian: vi.fn(), updateGuardian: vi.fn(),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let ClientFormPage;

beforeEach(async () => {
  ({ ClientFormPage } = await import('./ClientFormPage.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  getClient.mockReset();
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mountAt = (entry, path) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path={path} element={<ClientFormPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
};
const dob = () => document.querySelector('input[aria-label="Date of birth"]');
const settle = async () => { for (let i = 0; i < 40; i += 1) { if (dob()?.value) return; await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); } };

describe('Client DOB input — MM/DD/YYYY masked control', () => {
  it('Add Client: DOB is a masked MM/DD/YYYY text field (never a native date input)', () => {
    mountAt('/clients/new', '/clients/new');
    const el = dob();
    expect(el).toBeTruthy();
    expect(el.getAttribute('type')).toBe('text');
    expect(el.getAttribute('placeholder')).toBe('MM/DD/YYYY');
    expect(el.value).toBe(''); // empty on a fresh add
  });

  it('Add Client: typing a date shows MM/DD/YYYY in the field', () => {
    mountAt('/clients/new', '/clients/new');
    const el = dob();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '08272015');
    act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(dob().value).toBe('08/27/2015');
    expect(document.body.textContent).not.toMatch(/Invalid Date|NaN/);
  });

  it('Edit Client: existing 2015-08-27 renders as 08/27/2015', async () => {
    getClient.mockResolvedValue({ client: { firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '2015-08-27', status: 'ACTIVE', address: {}, version: 2 }, guardians: [] });
    mountAt('/clients/kid-1/edit', '/clients/:clientId/edit');
    await settle();
    expect(dob().value).toBe('08/27/2015');
    expect(dob().getAttribute('type')).toBe('text');
  });
});
