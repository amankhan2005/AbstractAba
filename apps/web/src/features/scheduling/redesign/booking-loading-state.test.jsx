import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Book Appointment loading state (Parts 20-22, 24). The spinner must ALWAYS
 * clear — including when onBook rejects unexpectedly (the "stuck spinner" bug) —
 * and a rapid double-click must produce exactly one request.
 */

const listAuthorizations = vi.fn();
const listCareTeam = vi.fn();
vi.mock('@/api/client', async (orig) => ({
  ...(await orig()),
  listAuthorizations: (...a) => listAuthorizations(...a),
  listCareTeam: (...a) => listCareTeam(...a),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let BookingModal;

beforeEach(async () => {
  // Pin the browser clock: new appointments may only be booked from today to the
  // end of the current month, so the typed fixture date must fall in that window.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-01T12:00:00'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ BookingModal } = await import('./SchedulingRedesign.jsx'));
  listAuthorizations.mockReset(); listCareTeam.mockReset();
  listAuthorizations.mockResolvedValue({ items: [
    { id: 'auth-1', authorizationNumber: 'ABA-001', serviceCode: 'ABA', status: 'APPROVED', authorizedUnits: 160, remainingUnits: 120, startDate: '2026-01-01', endDate: '2026-12-31' },
  ] });
  listCareTeam.mockResolvedValue([
    { id: 'asg-1', staffProfileId: 'bcba-1', role: 'BCBA', status: 'ACTIVE', staffName: 'Lee, Jordan' },
    { id: 'asg-2', staffProfileId: 'rbt-1', role: 'RBT', status: 'ACTIVE', staffName: 'Ray, Robin' },
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const clientOpts = [{ value: 'child-1', label: 'Alex R.' }];
const mount = (onBook) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><ToastProvider>
    <BookingModal open onClose={vi.fn()} clientOpts={clientOpts} staffOpts={[]} onBook={onBook} />
  </ToastProvider></QueryClientProvider>));
};
const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const qa = (sel) => [...document.querySelectorAll(sel)];
const selectByLabel = async (labelText, re) => {
  const field = qa('.rx-formfield').find((f) => f.textContent.includes(labelText));
  const trig = field.querySelector('.rx-select__trigger');
  await act(async () => { trig.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  const opt = qa('.rx-select__opt').find((o) => re.test(o.textContent));
  await act(async () => { opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const setVal = async (sel, v) => { const el = document.querySelector(sel); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve(); }); };
const bookBtn = () => qa('button').find((b) => /Book appointment/i.test(b.textContent));
const fill = async () => {
  await selectByLabel('Client', /Alex R\./); await flush();
  await selectByLabel('BCBA', /Lee, Jordan/); // default clinician type is BCBA (one clinician per appointment)
  await (async () => { const box = [...document.querySelectorAll('input[type="checkbox"]')].find((c) => /ABA-001/.test(c.getAttribute('aria-label') || '')); await act(async () => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); })();
  await setVal('input[aria-label="Appointment date"]', '09/09/2026');
};

describe('Book Appointment loading state', () => {
  it('clears the spinner even when onBook rejects unexpectedly (no stuck spinner)', async () => {
    const onBook = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { response: { data: { error: { message: 'Server exploded.' } } } }));
    mount(onBook);
    await flush();
    await fill();
    await act(async () => { bookBtn().dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(onBook).toHaveBeenCalledTimes(1);
    expect(bookBtn().disabled).toBeFalsy();          // loading cleared
    expect(document.body.textContent).toMatch(/Server exploded\./); // useful error shown
  });

  it('a rapid double-click issues exactly one onBook call', async () => {
    let resolve; const onBook = vi.fn(() => new Promise((r) => { resolve = r; }));
    mount(onBook);
    await flush();
    await fill();
    const b = bookBtn();
    await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(onBook).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); await Promise.resolve(); });
    await flush();
  });
});
