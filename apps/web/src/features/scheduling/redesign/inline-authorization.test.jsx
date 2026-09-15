import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * REGRESSION — scheduling inline "Create Authorization" writes the SAME
 * authoritative model the Company Child → Authorization screen writes: an ABA/FBA
 * ServiceAuthorization, selected by its unified `svc:` id. It is usable the
 * moment it is saved — the modal performs NO status transition (no fake
 * approval). No separate scheduling-authorization record is created.
 */

const listAuthorizations = vi.fn();
const createServiceAuthorization = vi.fn();
const transitionServiceAuthorization = vi.fn();
const listServiceAuthorizations = vi.fn();
vi.mock('@/api/client', () => ({
  listAppointments: vi.fn(async () => ({ items: [] })),
  listClients: vi.fn(async () => ({ items: [] })),
  listStaff: vi.fn(async () => ({ items: [] })),
  bookAppointment: vi.fn(),
  listAuthorizations: (...a) => listAuthorizations(...a),
  createServiceAuthorization: (...a) => createServiceAuthorization(...a),
  transitionServiceAuthorization: (...a) => transitionServiceAuthorization(...a),
  listServiceAuthorizations: (...a) => listServiceAuthorizations(...a),
}));
vi.mock('@/auth/store', () => ({ useAuthStore: (s) => s({ principal: { permissions: [], roles: ['owner'] } }), useOrgTimezone: () => null }));

let consoleErrorSpy;
const actW = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let BookingModal;

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ BookingModal } = await import('./SchedulingRedesign.jsx'));
  listAuthorizations.mockResolvedValueOnce({ items: [], meta: {} });
  createServiceAuthorization.mockResolvedValue({ id: 'sa-1', serviceType: 'ABA', status: 'NOT_SENT' });
  listAuthorizations.mockResolvedValue({ items: [{ id: 'svc:sa-1', serviceType: 'ABA', serviceCode: 'ABA', status: 'ACTIVE', authorizedUnits: 160, usedUnits: 0, remainingUnits: 160, startDate: '2026-08-01', endDate: '2026-12-31' }], meta: {} });
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actW(); consoleErrorSpy.mockRestore();
  expect(w, `act warnings: ${JSON.stringify(w)}`).toHaveLength(0);
  vi.clearAllMocks();
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <BookingModal open onClose={() => {}} onBook={async () => {}}
        clientOpts={[{ value: 'c-1', label: 'Aman Khan' }]} staffOpts={[{ value: 's-1', label: 'Jane Doe' }]} />
    </ToastProvider></QueryClientProvider>,
  ));
};
const waitFor = async (re) => { for (let i = 0; i < 60; i += 1) { if (re.test(document.body.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`missing ${re}: ${document.body.textContent.slice(0, 400)}`); };
const clickEl = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };
const clickBtn = async (re) => { const b = [...document.querySelectorAll('button')].find((x) => re.test(x.textContent)); await clickEl(b); };
const chooseFromSelect = async (triggerRe, optionRe) => {
  const trigger = [...document.querySelectorAll('button')].find((b) => triggerRe.test(b.textContent));
  await clickEl(trigger);
  let opt;
  for (let i = 0; i < 30 && !opt; i += 1) { opt = [...document.querySelectorAll('button[role="option"]')].find((e) => optionRe.test(e.textContent)); if (!opt) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
  await clickEl(opt);
};
const setNative = (el, val) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })); };

describe('BookingModal — inline authorization creation writes the authoritative ServiceAuthorization', () => {
  it('creates an ABA ServiceAuthorization and selects the svc: id — no approval step', async () => {
    mount();
    await chooseFromSelect(/Select a client/i, /Aman Khan/);
    await waitFor(/No active authorizations|Create authorization/);
    await clickBtn(/create authorization/i);
    await waitFor(/New authorization/);
    // Typed as MM/DD/YYYY into the shared date picker, which emits YYYY-MM-DD.
    const dates = [document.querySelector('input[aria-label="Authorization start date"]'), document.querySelector('input[aria-label="Authorization end date"]')];
    const num = document.querySelector('input[type="number"]');
    await act(async () => { setNative(dates[0], '08/01/2026'); setNative(dates[1], '12/31/2026'); if (num) setNative(num, '160'); await Promise.resolve(); });
    await clickBtn(/create & select/i);
    await waitFor(/Authorization added/);

    expect(createServiceAuthorization).toHaveBeenCalledTimes(1);
    const [clientId, body] = createServiceAuthorization.mock.calls[0];
    expect(clientId).toBe('c-1');
    expect(body.serviceType).toBe('ABA');
    expect(body.units).toBe(160);
    expect(transitionServiceAuthorization).not.toHaveBeenCalled();
    expect(listServiceAuthorizations).not.toHaveBeenCalled();
    const box = document.querySelector('input[type="checkbox"]');
    expect(box?.checked).toBe(true);
  });
});
