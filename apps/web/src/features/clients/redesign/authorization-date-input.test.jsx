import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';
import { formatDate, todayLocalISO } from '@/lib/format';

/**
 * ABA/FBA authorization Start/End dates use the masked MM/DD/YYYY control, and a
 * NEW authorization defaults Start Date to today — shown as MM/DD/YYYY, never
 * dd/mm/yyyy and never a native date input whose text the OS locale controls.
 */

const listServiceAuthorizations = vi.fn();
vi.mock('@/api/client', () => ({
  listServiceAuthorizations: (...a) => listServiceAuthorizations(...a),
  createServiceAuthorization: vi.fn(),
  updateServiceAuthorization: vi.fn(),
  transitionServiceAuthorization: vi.fn(),
  archiveServiceAuthorization: vi.fn(),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let AuthorizationsPanel;

beforeEach(async () => {
  ({ AuthorizationsPanel } = await import('./AuthorizationsPanel.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  listServiceAuthorizations.mockReset();
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><ToastProvider><AuthorizationsPanel clientId="c-1" /></ToastProvider></QueryClientProvider>));
};
const waitFor = async (re) => { for (let i = 0; i < 80; i += 1) { if (re.test(document.body.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found`); };
const btnByText = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };
const input = (label) => document.querySelector(`input[aria-label="${label}"]`);

describe('Add ABA/FBA authorization — date fields', () => {
  it('Start Date defaults to today and both dates render as MM/DD/YYYY masked text', async () => {
    listServiceAuthorizations.mockResolvedValue([]);
    mount();
    await waitFor(/No ABA authorization/);
    await click(btnByText(/Add ABA/));
    await waitFor(/Add ABA authorization/);

    const start = input('Start date');
    const end = input('End date');
    expect(start).toBeTruthy();
    expect(end).toBeTruthy();
    // Masked text control, not a native date input (whose text the locale owns).
    expect(start.getAttribute('type')).toBe('text');
    expect(start.getAttribute('placeholder')).toBe('MM/DD/YYYY');
    // Defaults to today's LOCAL date, shown MM/DD/YYYY.
    expect(start.value).toBe(formatDate(todayLocalISO()));
    expect(start.value).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(document.body.textContent).not.toMatch(/Invalid Date|NaN/);
  });

  it('FBA editor also uses the masked MM/DD/YYYY control', async () => {
    listServiceAuthorizations.mockResolvedValue([]);
    mount();
    await waitFor(/No FBA authorization/);
    await click(btnByText(/Add FBA/));
    await waitFor(/Add FBA authorization/);
    const start = input('Start date');
    expect(start.getAttribute('type')).toBe('text');
    expect(start.value).toBe(formatDate(todayLocalISO()));
  });
});
