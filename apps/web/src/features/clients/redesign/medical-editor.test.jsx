import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Spec Module 3.3/3.4 — the medical editor:
 *   - the Status dropdown is populated with the real backend statuses
 *     (never an empty/unusable dropdown);
 *   - the attachment file input accepts image + PDF and matches the server's
 *     upload allowlist (no webp, which the server rejects).
 * Any React act() warning fails the test.
 */
const listMedical = vi.fn();
vi.mock('@/api/client', () => ({
  listMedical: (...a) => listMedical(...a),
  addMedical: vi.fn(), updateMedical: vi.fn(), removeMedical: vi.fn(),
  createDocument: vi.fn(), uploadDocumentFile: vi.fn(),
}));

let currentPermissions = ['clients.medical.manage'];
vi.mock('@/auth/store', () => ({
  useAuthStore: (selector) => selector({ principal: { permissions: currentPermissions, roles: ['org_admin'] } }),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

let host; let root; let MedicalPanel;
beforeEach(async () => {
  ({ MedicalPanel } = await import('./MedicalPanel.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  listMedical.mockReset(); listMedical.mockResolvedValue([]);
  currentPermissions = ['clients.medical.manage'];
});
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = undefined; host = undefined;
  const w = actWarnings();
  consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}><ToastProvider><MedicalPanel clientId="c-1" /></ToastProvider></QueryClientProvider>,
    );
  });
};
const waitFor = async (re) => {
  for (let i = 0; i < 60; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
  throw new Error(`text ${re} never appeared`);
};
const clickAdd = async () => {
  const btn = [...host.querySelectorAll('button')].find((b) => /^Add$/.test(b.textContent));
  await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  // The editor Modal renders in a portal on document.body; wait for it.
  for (let i = 0; i < 60 && !document.querySelector('input[type="file"]'); i += 1) { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
};

describe('MedicalPanel editor', () => {
  it('populates the Status dropdown with the real backend statuses (not an empty dropdown)', async () => {
    mount();
    await waitFor(/Medical conditions/);
    await clickAdd();
    // The status control is the shared custom Select: a trigger button that
    // defaults to the current value and opens a listbox of role="option" items.
    const triggers = [...document.querySelectorAll('.rx-select__trigger')];
    expect(triggers.length, 'a status Select trigger is rendered').toBeGreaterThan(0);
    // it shows a real default value, never an empty placeholder
    expect(triggers[0].textContent).toMatch(/Active/i);
    await act(async () => { triggers[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim());
    expect(options).toEqual(['Active', 'Resolved', 'Chronic', 'Monitoring']);
    expect(options.length).toBe(4); // never empty/unusable
  });

  it('offers an image/PDF attachment input matching the server allowlist (no webp)', async () => {
    mount();
    await waitFor(/Medical conditions/);
    await clickAdd();
    const file = document.querySelector('input[type="file"]');
    expect(file, 'a file input is rendered').toBeTruthy();
    const accept = file.getAttribute('accept') || '';
    expect(accept).toMatch(/application\/pdf/);
    expect(accept).toMatch(/image\/png/);
    expect(accept).toMatch(/image\/jpeg/);
    expect(accept).not.toMatch(/webp/); // server rejects webp
  });
});
