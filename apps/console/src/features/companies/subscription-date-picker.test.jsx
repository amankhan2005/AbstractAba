// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DatePicker } from '@aba1on1/date-picker';

/**
 * Super Admin console uses the SAME shared date picker as the tenant app.
 * Verifies the subscription validity form sends YYYY-MM-DD picked on the
 * calendar / typed as MM/DD/YYYY, and that the picker co-exists with the
 * console Modal's capture-phase Escape + focus trap.
 */
const updateSubscriptionValidity = vi.fn();
vi.mock('@/api/client', () => ({
  fetchOrgSubscription: vi.fn().mockResolvedValue({
    id: 'sub-1', planName: 'Growth', amount: 9900, currency: 'USD', billingInterval: 'MONTHLY',
    effectiveStatus: 'ACTIVE', startDate: '2026-09-01', renewalDate: '2026-10-01', daysRemaining: 18, expired: false,
  }),
  listPlans: vi.fn().mockResolvedValue([]),
  assignSubscription: vi.fn(),
  changeSubscriptionPackage: vi.fn(),
  extendSubscription: vi.fn(),
  updateSubscriptionValidity: (...a) => updateSubscriptionValidity(...a),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  updateSubscriptionValidity.mockReset().mockResolvedValue({});
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = (el) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(el));
};
const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const q = (s) => document.querySelector(s);
const buttons = () => [...document.querySelectorAll('button')];
const byText = (re) => buttons().find((b) => re.test(b.textContent.trim()));
const byLabel = (re) => buttons().find((b) => re.test(b.getAttribute('aria-label') || ''));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };
const key = (el, k, opts = {}) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts })); });
const type = (el, raw) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, raw);
  act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('Console subscription validity — shared date picker', () => {
  it('shows MM/DD/YYYY fields and submits YYYY-MM-DD from the calendar and from typing', async () => {
    const { SubscriptionManagerRx } = await import('./SubscriptionManagerRx.jsx');
    const { ToastProvider } = await import('@/components');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount(<QueryClientProvider client={qc}><ToastProvider><SubscriptionManagerRx organizationId="org-1" /></ToastProvider></QueryClientProvider>);
    await flush();

    await click(byText(/^Update validity$/));
    const start = q('input[aria-label="Start date"]');
    const renewal = q('input[aria-label="Renewal date"]');
    expect(start.value).toBe('09/01/2026');
    expect(renewal.value).toBe('10/01/2026');
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(0);

    // Pick a new renewal date on the calendar.
    await click(renewal.parentElement.querySelector('button[aria-label="Open calendar"]'));
    expect(q('.dp-pop [role="grid"]').getAttribute('aria-label')).toBe('October 2026');
    await click(byLabel(/^Next month$/));
    await click(q('.dp-pop [data-iso="2026-11-15"]'));
    expect(renewal.value).toBe('11/15/2026');

    // Type a new start date.
    type(start, '09052026');
    await click(byText(/^Save$/));
    await flush();
    expect(updateSubscriptionValidity).toHaveBeenCalledWith('sub-1', { startDate: '2026-09-05', endDate: '2026-11-15' });
  });

  it('inside the console Modal, Escape closes only the calendar and Tab stays in the calendar', async () => {
    const { Modal } = await import('@/components');
    const onClose = vi.fn();
    function Harness() {
      const [v, setV] = useState('2026-09-13');
      return <Modal title="Record payment" onClose={onClose}><DatePicker aria-label="Payment date" value={v} onChange={(e) => setV(e.target.value)} /></Modal>;
    }
    mount(<Harness />);
    await click(byLabel(/^Open calendar$/));
    const pop = q('.dp-pop');
    expect(pop).toBeTruthy();
    expect(document.activeElement.getAttribute('data-iso')).toBe('2026-09-13');

    key(document.activeElement, 'Tab');
    expect(pop.contains(document.activeElement)).toBe(true);
    key(document.activeElement, 'Tab', { shiftKey: true });
    expect(pop.contains(document.activeElement)).toBe(true);

    key(document.activeElement, 'Escape');
    expect(q('.dp-pop')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(q('[role="dialog"][aria-label="Record payment"]')).toBeTruthy();
  });
});
