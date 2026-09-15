import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Spec Module 6 Parts 3/9/35 — the client Authorizations panel shows
 * Authorized / Used / Remaining for an authorization, and Hours are DERIVED
 * (read-only) from Units, never an independently editable field. act()-clean.
 */
const listServiceAuthorizations = vi.fn();
vi.mock('@/api/client', () => ({
  listServiceAuthorizations: (...a) => listServiceAuthorizations(...a),
  createServiceAuthorization: vi.fn(),
  updateServiceAuthorization: vi.fn(),
  transitionServiceAuthorization: vi.fn(),
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
const waitFor = async (re, where = () => host.textContent) => {
  for (let i = 0; i < 80; i += 1) { if (re.test(where())) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
  throw new Error(`text ${re} never appeared`);
};
const btn = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };

describe('AuthorizationsPanel — Module 6', () => {
  it('shows Authorized / Used / Remaining for an authorization', async () => {
    listServiceAuthorizations.mockResolvedValue([
      { id: 'sa-1', serviceType: 'ABA', status: 'APPROVED', units: 160, usedUnits: 40, remainingUnits: 120, hours: 40, startDate: '2026-08-01', endDate: '2026-12-31' },
    ]);
    mount();
    await waitFor(/authorized/i);
    expect(host.textContent).toMatch(/160 authorized/i);
    expect(host.textContent).toMatch(/40 used/i);
    expect(host.textContent).toMatch(/120 remaining/i);
  });

  it('the Add editor derives Hours from Units and does not let Hours be edited', async () => {
    listServiceAuthorizations.mockResolvedValue([]); // no ABA/FBA yet → Add buttons show
    mount();
    await waitFor(/No ABA authorization|No FBA authorization/);
    await click(btn(/Add ABA/));
    await waitFor(/Hours \(derived\)/, () => document.body.textContent);
    // find the Hours field input — it must be read-only / disabled
    const hoursLabel = [...document.querySelectorAll('.rx-formfield label')].find((l) => /Hours \(derived\)/.test(l.textContent));
    const hoursInput = hoursLabel?.closest('.rx-formfield')?.querySelector('input');
    expect(hoursInput).toBeTruthy();
    expect(hoursInput.readOnly || hoursInput.disabled).toBe(true);
    // there is no editable field labelled just "Hours"
    const plainHours = [...document.querySelectorAll('.rx-formfield label')].find((l) => l.textContent.trim() === 'Hours');
    expect(plainHours).toBeFalsy();
  });
});
