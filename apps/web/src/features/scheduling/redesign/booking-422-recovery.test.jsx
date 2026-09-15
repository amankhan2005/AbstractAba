import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * P0 — POST /v1/scheduling/appointments 422 recovery (Parts 14–17, 21–24, 33).
 *
 * When the backend rejects a booking with a 422, the button MUST stop loading,
 * the EXACT backend reason must be shown so the user knows what to fix, the form
 * must stay usable, and a corrected retry must succeed. This is the difference
 * between the reported "spins forever, no idea why" and a recoverable form.
 * act()-clean.
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
    { id: 'svc:auth-1', authorizationNumber: 'ABA-001', serviceCode: 'ABA', status: 'APPROVED', authorizedUnits: 160, remainingUnits: 120, startDate: '2026-01-01', endDate: '2026-12-31' },
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
  vi.clearAllMocks();
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
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };

// A realistic axios-shaped 422 rejection carrying the backend error contract.
const reject422 = (message) => Object.assign(new Error('Request failed with status code 422'), {
  response: { status: 422, data: { error: { code: 'AUTHORIZATION_INVALID', message } } },
});

describe('Book Appointment — 422 recovery', () => {
  it('shows the exact backend reason on 422, clears the spinner, and keeps the form usable', async () => {
    const reason = 'The authorization is not valid for this client, service, or date.';
    const onBook = vi.fn().mockRejectedValueOnce(reject422(reason));
    mount(onBook);
    await flush();
    await fill();
    await click(bookBtn());
    await flush();
    expect(onBook).toHaveBeenCalledTimes(1);
    expect(bookBtn().disabled).toBeFalsy();                    // spinner cleared
    expect(document.body.textContent).toMatch(/not valid for this client, service, or date/); // exact reason
    expect(bookBtn()).toBeTruthy();                            // form still usable
  });

  it('a corrected retry after a 422 succeeds', async () => {
    const onBook = vi.fn()
      .mockRejectedValueOnce(reject422('The staff member is not available at that time.'))
      .mockResolvedValueOnce({ id: 'appt-1' });
    mount(onBook);
    await flush();
    await fill();
    await click(bookBtn());     // first attempt → 422
    await flush();
    expect(document.body.textContent).toMatch(/not available at that time/);
    await click(bookBtn());     // retry → success
    await flush();
    expect(onBook).toHaveBeenCalledTimes(2);
    expect(bookBtn()?.disabled ?? false).toBeFalsy();
  });
});
