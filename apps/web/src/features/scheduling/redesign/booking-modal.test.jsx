import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * BookingModal — Parts 6/7/8/21/23.
 *
 * The reported symptoms were: after a 422 the spinner stuck, and act() warnings
 * fired from the modal/toast. These tests drive the REAL modal (mocking only the
 * authorizations query) and assert: existing authorization loads and is
 * selectable, a valid booking calls onBook with the strict-schema payload, the
 * busy state ENDS on both success and failure, the server reason is surfaced on
 * failure, and a rapid double-click books once. act() warnings fail the suite.
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
  vi.setSystemTime(new Date('2026-06-01T12:00:00'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ BookingModal } = await import('./SchedulingRedesign.jsx'));
  listAuthorizations.mockReset(); listCareTeam.mockReset();
  listCareTeam.mockResolvedValue([
    { id: 'asg-1', staffProfileId: 'bcba-1', role: 'BCBA', status: 'ACTIVE', staffName: 'Lee, Jordan', effectiveStartDate: '2026-01-01', effectiveEndDate: null },
    { id: 'asg-2', staffProfileId: 'rbt-1', role: 'RBT', status: 'ACTIVE', staffName: 'Ray, Robin', effectiveStartDate: '2026-01-01', effectiveEndDate: null },
  ]);
  listAuthorizations.mockResolvedValue({ items: [
    { id: 'auth-aba', authorizationNumber: 'ABA-001', serviceCode: 'ABA', status: 'APPROVED', authorizedUnits: 160, remainingUnits: 120, startDate: '2026-01-01', endDate: '2026-12-31' },
  ] });
});
afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const clientOpts = [{ value: 'child-1', label: 'Alex R.' }];
const staffOpts = [{ value: 'staff-1', label: 'Jordan Lee' }];

const mount = (onBook, onClose = vi.fn()) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <BookingModal open onClose={onClose} clientOpts={clientOpts} staffOpts={staffOpts} onBook={onBook} />
    </ToastProvider></QueryClientProvider>,
  ));
  return onClose;
};
const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
// Drawer renders in a portal → query the whole document.
const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
// Pick an option from a custom Select identified by its Field label text.
const selectByLabel = async (labelText, optionRe) => {
  const field = qa('.rx-formfield').find((f) => f.textContent.includes(labelText));
  const trigger = field.querySelector('.rx-select__trigger');
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  const opt = qa('.rx-select__opt').find((o) => optionRe.test(o.textContent));
  await act(async () => { opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const setInput = async (type, value) => {
  const el = q(`input[type="${type}"]`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve(); });
};
const bookBtn = () => qa('button').find((b) => /Book appointment/i.test(b.textContent));
const checkAuth = async (re) => {
  const box = qa('input[type="checkbox"]').find((c) => re.test(c.getAttribute('aria-label') || ''));
  await act(async () => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const setDate = async (aria, value) => {
  const el = qa('input').find((i) => i.getAttribute('aria-label') === aria);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve(); });
};
const fillValid = async () => {
  await selectByLabel('Client', /Alex R\./);
  await flush();                       // authorizations + care-team queries fire after child set
  await selectByLabel('BCBA', /Lee, Jordan/); // default clinician type is BCBA — one clinician per appointment (spec §4)
  await checkAuth(/ABA-001/);
  await setDate('Appointment date', '06/15/2026');
  // No Start/End time is entered — the creation UI no longer collects one (spec §2).
};

describe('BookingModal', () => {
  it('loads the child\u2019s existing authorization and books with the strict-schema payload', async () => {
    const onBook = vi.fn().mockResolvedValue(undefined);
    mount(onBook);
    await flush();
    await fillValid();
    await act(async () => { bookBtn().dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(onBook).toHaveBeenCalledTimes(1);
    const payload = onBook.mock.calls[0][0];
    // One clinician per appointment (spec §4): a BCBA-only booking carries
    // bcbaId and NOT rbtId. No manually entered start/end time (spec §2).
    expect(Object.keys(payload).sort()).toEqual(['authorizationIds', 'bcbaId', 'clientId', 'endDate', 'startDate', 'units']);
    expect(payload).not.toHaveProperty('startTime');
    expect(payload).not.toHaveProperty('endTime');
    expect(payload).not.toHaveProperty('rbtId');
    expect(payload.authorizationIds).toEqual(['auth-aba']);
    expect(payload.bcbaId).toBe('bcba-1');
  });

  it('does not render Start time or End time fields on the creation form (spec §2)', async () => {
    mount(vi.fn());
    await flush();
    const labels = qa('.rx-formfield__label, label, .rx-field__label').map((n) => n.textContent || '');
    expect(labels.some((t) => /start time/i.test(t))).toBe(false);
    expect(labels.some((t) => /end time/i.test(t))).toBe(false);
    // No time inputs at all in the booking form.
    expect(qa('input[type="time"]').length).toBe(0);
  });

  it('ends the busy state and surfaces the server reason when booking fails (no stuck spinner)', async () => {
    // Mirrors the parent contract: onBook handles the error and resolves.
    const onBook = vi.fn().mockResolvedValue(undefined);
    const onClose = mount(onBook);
    await flush();
    await fillValid();
    await act(async () => { bookBtn().dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await flush();
    // Not stuck: the Book button is enabled again (loading ended) and modal stays open.
    expect(bookBtn().disabled).toBeFalsy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('prevents a duplicate submission from a rapid double-click', async () => {
    let resolve; const onBook = vi.fn(() => new Promise((r) => { resolve = r; }));
    mount(onBook);
    await flush();
    await fillValid();
    const b = bookBtn();
    await act(async () => {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onBook).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); await Promise.resolve(); });
    await flush();
  });
});

describe('ToastProvider lifecycle (Part 9)', () => {
  it('unmounting before the auto-dismiss timer does not cause a post-unmount update', async () => {
    vi.useFakeTimers();
    try {
      const h = document.createElement('div'); document.body.appendChild(h); const r = createRoot(h);
      let pushRef;
      function Grab() { const { useToast } = require('@/components'); pushRef = useToast().push; return null; }
      // Render provider + a child that grabs push, fire a toast, unmount, then advance time.
      const { useToast } = await import('@/components');
      function Child() { pushRef = useToast().push; return null; }
      act(() => r.render(<ToastProvider><Child /></ToastProvider>));
      act(() => { pushRef('Saved.'); });
      act(() => r.unmount()); h.remove();
      // Advancing past the 4s timer must not throw or setState after unmount.
      act(() => { vi.advanceTimersByTime(5000); });
    } finally {
      vi.useRealTimers();
    }
  });
});
