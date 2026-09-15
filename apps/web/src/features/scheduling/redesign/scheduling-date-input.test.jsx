import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';
import { formatDate } from '@/lib/format';

/**
 * New Appointment date field — Parts 17-25. The visible, editable appointment
 * date is the deterministic masked MM/DD/YYYY control, NOT a native date input
 * whose text the OS/browser locale renders as dd/mm/yyyy. A user-typed
 * MM/DD/YYYY is parsed to the correct calendar day and survives the ISO
 * round-trip into the booking payload without shifting a day.
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
  listCareTeam.mockResolvedValue([
    { id: 'asg-1', staffProfileId: 'bcba-1', role: 'BCBA', status: 'ACTIVE', staffName: 'Lee, Jordan' },
    { id: 'asg-2', staffProfileId: 'rbt-1', role: 'RBT', status: 'ACTIVE', staffName: 'Ray, Robin' },
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
const mount = (onBook) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <BookingModal open onClose={vi.fn()} clientOpts={clientOpts} staffOpts={staffOpts} onBook={onBook} />
    </ToastProvider></QueryClientProvider>,
  ));
};
const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const qa = (sel) => [...document.querySelectorAll(sel)];
const dateField = () => document.querySelector('input[aria-label="Appointment date"]');
const selectByLabel = async (labelText, optionRe) => {
  const field = qa('.rx-formfield').find((f) => f.textContent.includes(labelText));
  const trigger = field.querySelector('.rx-select__trigger');
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  const opt = qa('.rx-select__opt').find((o) => optionRe.test(o.textContent));
  await act(async () => { opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const setVal = async (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve(); });
};
const bookBtn = () => qa('button').find((b) => /Book appointment/i.test(b.textContent));

describe('New Appointment date input', () => {
  it('is a masked MM/DD/YYYY text field, not a native date input', async () => {
    mount(vi.fn().mockResolvedValue(undefined));
    await flush();
    const el = dateField();
    expect(el).toBeTruthy();
    expect(el.getAttribute('type')).toBe('text');
    expect(el.getAttribute('placeholder')).toBe('MM/DD/YYYY');
  });

  it('parses a typed MM/DD/YYYY to the correct day and books it timezone-safe', async () => {
    const onBook = vi.fn().mockResolvedValue(undefined);
    mount(onBook);
    await flush();
    await selectByLabel('Client', /Alex R\./);
    await flush();
    await selectByLabel('BCBA', /Lee, Jordan/); // default clinician type is BCBA (one clinician per appointment)
    await (async () => { const box = [...document.querySelectorAll('input[type="checkbox"]')].find((c) => /ABA-001/.test(c.getAttribute('aria-label') || '')); await act(async () => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); })();
    // Type into the VISIBLE masked field (raw digits) → shows 09/03/2026.
    await setVal(dateField(), '09032026');
    expect(dateField().value).toBe('09/03/2026');

    await act(async () => { bookBtn().dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(onBook).toHaveBeenCalledTimes(1);
    const { startDate } = onBook.mock.calls[0][0];
    // Sent as a timezone-safe calendar date — no day shift, and no clock time (spec §2).
    expect(startDate).toBe('2026-09-03');
    expect(onBook.mock.calls[0][0]).not.toHaveProperty('startTime');
    expect(formatDate(new Date(`${startDate}T00:00:00`))).toBe('09/03/2026');
    expect(document.body.textContent).not.toMatch(/Invalid Date|NaN/);
  });
});

describe('New Appointment date window — today through the end of the current month', () => {
  const pick = async (fieldLabel) => {
    const input = document.querySelector(`input[aria-label="${fieldLabel}"]`);
    const btn = input.parentElement.querySelector('button[aria-label="Open calendar"]');
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  };
  const cell = (iso) => document.querySelector(`.dp-pop [data-iso="${iso}"]`);
  const fillRequired = async () => {
    await selectByLabel('Client', /Alex R\./); await flush();
    await selectByLabel('BCBA', /Lee, Jordan/);
    const box = [...document.querySelectorAll('input[type="checkbox"]')].find((c) => /ABA-001/.test(c.getAttribute('aria-label') || ''));
    await act(async () => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  };

  it('opens on the current month; past dates and other months are not selectable; today → month end are', async () => {
    vi.setSystemTime(new Date('2026-09-13T12:00:00'));
    mount(vi.fn().mockResolvedValue(undefined)); await flush();
    await pick('Appointment date');
    expect(document.querySelector('.dp-pop [role="grid"]').getAttribute('aria-label')).toBe('September 2026');
    expect(cell('2026-09-12').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-09-01').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-09-13').getAttribute('aria-disabled')).toBeNull();
    expect(cell('2026-09-30').getAttribute('aria-disabled')).toBeNull();
    expect(cell('2026-10-01').getAttribute('aria-disabled')).toBe('true'); // outside-month day shown but disabled
    const prev = document.querySelector('.dp-pop button[aria-label="Previous month"]');
    const next = document.querySelector('.dp-pop button[aria-label="Next month"]');
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    await act(async () => { cell('2026-09-12').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(dateField().value).toBe('');
    await act(async () => { cell('2026-09-13').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(dateField().value).toBe('09/13/2026');
  });

  it('typed past / next-month dates are refused in the field and nothing is booked', async () => {
    vi.setSystemTime(new Date('2026-09-13T12:00:00'));
    const onBook = vi.fn().mockResolvedValue(undefined);
    mount(onBook); await flush();
    await fillRequired();
    await setVal(dateField(), '09122026');
    expect(document.body.textContent).toContain('Choose a date on or after 09/13/2026.');
    await setVal(dateField(), '10012026');
    expect(document.body.textContent).toContain('Choose a date on or before 09/30/2026.');
    await act(async () => { bookBtn().dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(onBook).not.toHaveBeenCalled();
  });

  it('a current-month range 09/13 → 09/30 books; an end date crossing into next month is refused', async () => {
    vi.setSystemTime(new Date('2026-09-13T12:00:00'));
    const onBook = vi.fn().mockResolvedValue(undefined);
    mount(onBook); await flush();
    await fillRequired();
    const end = () => document.querySelector('input[aria-label="Appointment end date"]');
    await setVal(dateField(), '09132026');
    await setVal(end(), '10052026');
    expect(document.body.textContent).toContain('Choose a date on or before 09/30/2026.');
    await setVal(end(), '09302026');
    await act(async () => { bookBtn().dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(onBook).toHaveBeenCalledTimes(1);
    expect(onBook.mock.calls[0][0]).toMatchObject({ startDate: '2026-09-13', endDate: '2026-09-30' });
  });

  it('the backend refusal message is shown as-is (server enforces the same window)', async () => {
    vi.setSystemTime(new Date('2026-09-13T12:00:00'));
    const onBook = vi.fn().mockRejectedValue({ response: { status: 422, data: { error: { code: 'APPOINTMENT_DATE_OUTSIDE_CURRENT_MONTH', message: 'Appointments can only be scheduled within the current month.' } } } });
    mount(onBook); await flush();
    await fillRequired();
    await setVal(dateField(), '09202026');
    await act(async () => { bookBtn().dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(document.body.textContent).toContain('Appointments can only be scheduled within the current month.');
  });
});
