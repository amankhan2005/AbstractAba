import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Medical Condition / History modals (Parts 6-9, 30). Dates render MM/DD/YYYY,
 * the status uses the real backend enum, and Add Document offers a premium
 * drag-&-drop upload zone (real upload — the file input targets the documents API).
 */

const listMedical = vi.fn();
vi.mock('@/api/client', async (orig) => ({
  ...(await orig()),
  listMedical: (...a) => listMedical(...a),
  addMedical: vi.fn(), updateMedical: vi.fn(), removeMedical: vi.fn(),
  createDocument: vi.fn(), uploadDocumentFile: vi.fn(),
}));
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { permissions: ['clients.medical.manage'] } }) }));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let MedicalPanel;

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ MedicalPanel } = await import('./MedicalPanel.jsx'));
  listMedical.mockReset();
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><ToastProvider><MedicalPanel clientId="c-1" /></ToastProvider></QueryClientProvider>));
};
const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const qa = (sel) => [...document.querySelectorAll(sel)];
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };

describe('Medical modals', () => {
  it('lists a condition with its onset date in MM/DD/YYYY', async () => {
    listMedical.mockResolvedValue([
      { id: 'm1', type: 'CONDITION', label: 'ADHD', status: 'ACTIVE', onsetDate: '2015-08-27', provider: 'Dr. Lee', attachments: [] },
    ]);
    mount();
    await flush();
    expect(host.textContent).toMatch(/ADHD/);
    expect(host.textContent).toMatch(/08\/27\/2015/);
    expect(host.textContent).not.toMatch(/2015-08-27/);
  });

  it('opens the Add condition modal with a MM/DD/YYYY date field and a premium upload zone', async () => {
    listMedical.mockResolvedValue([]);
    mount();
    await flush();
    // First "Add" button is the conditions section.
    const addBtn = qa('button').find((b) => /^Add$/.test(b.textContent.trim()));
    await click(addBtn);
    await flush();
    // Masked date field (Onset date), not a native date input.
    const onset = document.querySelector('input[aria-label="Onset date"]');
    expect(onset).toBeTruthy();
    expect(onset.getAttribute('type')).toBe('text');
    expect(onset.getAttribute('placeholder')).toBe('MM/DD/YYYY');
    // Premium drag-&-drop upload zone with a real (hidden) file input.
    const zone = document.querySelector('[aria-label="Upload document — drag and drop or choose a file"]');
    expect(zone).toBeTruthy();
    expect(zone.textContent).toMatch(/Drag & drop/i);
    expect(zone.textContent).toMatch(/PDF, PNG, JPG or TIFF/);
    expect(zone.querySelector('input[type="file"]')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Invalid Date|NaN/);
  });
});
