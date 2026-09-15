import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components';
import { zonedWallTimeToUtc } from '@/lib/businessDate';

/**
 * SCHEDULING PAGE — calendar, selected date, Book Appointment and Reschedule on
 * the existing APIs. The clock is pinned to 09/14/2026 11:00 AM New York; the
 * organization timezone (not the browser) decides every date.
 */
const TZ = 'America/New_York';
const mid = (y, m, d) => zonedWallTimeToUtc(y, m, d, 0, 0, 0, TZ).toISOString();
const at = (y, m, d, hh, mm = 0) => zonedWallTimeToUtc(y, m, d, hh, mm, 0, TZ).toISOString();

const auth = vi.hoisted(() => ({ permissions: [] }));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ status: 'authenticated', principal: { permissions: auth.permissions, roles: auth.permissions.includes('scheduling.write') ? ['org_admin'] : ['bcba'] } }),
  useOrgTimezone: () => 'America/New_York',
}));
const api = vi.hoisted(() => ({
  listAppointments: vi.fn(), listClients: vi.fn(), listStaff: vi.fn(), listAuthorizations: vi.fn(), listCareTeam: vi.fn(),
  bookAppointment: vi.fn(), createServiceAuthorization: vi.fn(), getAppointment: vi.fn(), updateAppointment: vi.fn(), cancelAppointment: vi.fn(),
  listAppointmentNotesOverview: vi.fn(), getAppointmentNote: vi.fn(), saveAppointmentNote: vi.fn(), deleteAppointmentNote: vi.fn(),
}));
vi.mock('@/api/client', () => Object.fromEntries(Object.keys(api).map((k) => [k, (...a) => api[k](...a)])));

const APPTS = () => [
  { id: 'a-timed', clientId: 'c1', clientName: 'Mia Khan', bcbaId: 's1', bcbaName: 'Ada Lovelace', rbtId: null, staffProfileId: 's1', status: 'SCHEDULED', timeSet: true, startAt: at(2026, 9, 14, 9), endAt: at(2026, 9, 14, 10), units: 4, authorizationIds: ['svc:1'], version: 3 },
  { id: 'a-date', clientId: 'c2', clientName: 'Sam Torres', rbtId: 's2', rbtName: 'Nia Patel', bcbaId: null, staffProfileId: 's2', status: 'SCHEDULED', timeSet: false, startAt: mid(2026, 9, 14), endAt: mid(2026, 9, 15), units: 6, authorizationIds: ['svc:1', 'svc:2'], version: 1 },
  { id: 'a-done', clientId: 'c1', clientName: 'Mia Khan', bcbaId: 's1', bcbaName: 'Ada Lovelace', staffProfileId: 's1', status: 'COMPLETED', timeSet: false, startAt: mid(2026, 9, 3), endAt: mid(2026, 9, 4), units: 4, authorizationIds: ['svc:1'], version: 2 },
];

let host; let root; let qc; let SchedulingRedesign; let consoleErrorSpy;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at(2026, 9, 14, 11)));
  consoleErrorSpy = vi.spyOn(console, 'error');
  for (const fn of Object.values(api)) fn.mockReset();
  auth.permissions = ['scheduling.read', 'scheduling.write'];
  api.listAppointments.mockResolvedValue({ items: APPTS(), meta: { nextCursor: null } });
  api.listClients.mockResolvedValue({ items: [{ id: 'c1', firstName: 'Mia', lastName: 'Khan' }, { id: 'c2', firstName: 'Sam', lastName: 'Torres' }] });
  api.listStaff.mockResolvedValue({ items: [] });
  api.listCareTeam.mockResolvedValue([{ id: 't1', staffProfileId: 's1', role: 'BCBA', status: 'ACTIVE', staffName: 'Lovelace, Ada' }]);
  api.listAuthorizations.mockResolvedValue({ items: [{ id: 'svc:1', authorizationNumber: 'ABA-1', serviceCode: 'ABA', status: 'ACTIVE', authorizedUnits: 400, remainingUnits: 300, startDate: '2026-09-01', endDate: '2026-12-31' }] });
  api.listAppointmentNotesOverview.mockResolvedValue({ businessDate: '2026-09-14', items: [] });
  api.getAppointmentNote.mockResolvedValue({ exists: false, note: null, canEdit: false });
  ({ SchedulingRedesign } = await import('./SchedulingRedesign.jsx'));
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined;
  vi.useRealTimers();
  const w = consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
  consoleErrorSpy.mockRestore();
  expect(w).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><ToastProvider><MemoryRouter><SchedulingRedesign /></MemoryRouter></ToastProvider></QueryClientProvider>));
};
const settle = async (n = 40) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const cell = (key) => document.querySelector(`[data-date="${key}"]`);
const panel = () => document.querySelector('[aria-label="Selected date"]');
const cards = () => [...panel().querySelectorAll('.rx-sch__appt')];
const button = (re, scope = document) => [...scope.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()) || re.test(b.getAttribute('aria-label') ?? ''));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }); await settle(); };
const qa = (sel) => [...document.querySelectorAll(sel)];
const setInput = async (el, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('Scheduling page — calendar', () => {
  it('loads real appointments with ONE range request, renders the month grid, today and the default selection', async () => {
    mount(); await settle();
    expect(document.querySelector('h1').textContent).toBe('Scheduling');
    expect(button(/^Book Appointment$/)).toBeTruthy();
    expect(document.querySelector('.rx-sch__month').textContent).toBe('September 2026');
    expect(qa('.rx-sch__cell')).toHaveLength(42);
    // one range request (paged at 100), no per-appointment detail requests
    expect(api.listAppointments).toHaveBeenCalledTimes(1);
    const params = api.listAppointments.mock.calls[0][0];
    expect(params).toMatchObject({ limit: 100, from: mid(2026, 7, 30) });
    expect(api.getAppointment).not.toHaveBeenCalled();
    expect(api.listClients).toHaveBeenCalledTimes(1);
    // today (org timezone) and default selection
    expect(cell('2026-09-14').getAttribute('aria-current')).toBe('date');
    expect(cell('2026-09-14').getAttribute('aria-pressed')).toBe('true');
    expect(cell('2026-09-14').getAttribute('aria-label')).toBe('Monday, 09/14/2026 (today), 2 appointments');
    expect(qa('.rx-sch__cell[tabindex="0"]').map((c) => c.dataset.date)).toEqual(['2026-09-14']);
    expect(panel().querySelector('.rx-sch__day-title').textContent).toBe('Monday, 09/14/2026');
    // month summary from the loaded data
    expect(document.querySelector('.rx-sch__stats').textContent).toContain('Appointments3');
    expect(document.querySelector('.rx-sch__stats').textContent).toContain('Scheduled2');
    expect(document.querySelector('.rx-sch__stats').textContent).toContain('Completed1');
  });

  it('appointment cards show client, time only when timed, clinician role, status, units and authorizations', async () => {
    mount(); await settle();
    const [timed, dateOnly] = cards();
    expect(timed.querySelector('.rx-sch__appt-client').textContent).toBe('Mia Khan');
    expect(timed.querySelector('.rx-sch__appt-when').textContent).toBe('9:00 AM – 10:00 AM');
    expect(timed.querySelector('.rx-sch__appt-people').textContent).toBe('BCBAAda Lovelace');
    expect(timed.textContent).toContain('Scheduled');
    expect(timed.textContent).toContain('4 units');
    expect(timed.textContent).toContain('1 authorization');
    expect(dateOnly.querySelector('.rx-sch__appt-client').textContent).toBe('Sam Torres');
    expect(dateOnly.querySelector('.rx-sch__appt-when')).toBeNull(); // no fabricated midnight
    expect(dateOnly.textContent).not.toMatch(/12:00 AM/);
    expect(dateOnly.querySelector('.rx-sch__appt-people').textContent).toBe('RBTNia Patel');
    expect(dateOnly.textContent).toContain('2 authorizations');
    expect(timed.querySelector('a').getAttribute('href')).toBe('/scheduling/appointments/a-timed');
  });

  it('clicking a date updates the panel; an empty date shows the empty state; arrow keys move the selection', async () => {
    mount(); await settle();
    await click(cell('2026-09-03'));
    expect(cell('2026-09-03').getAttribute('aria-pressed')).toBe('true');
    expect(panel().querySelector('.rx-sch__day-title').textContent).toBe('Thursday, 09/03/2026');
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain('Completed');
    expect(button(/^Reschedule$/, panel())).toBeUndefined(); // only scheduled appointments
    await click(cell('2026-09-16'));
    expect(panel().textContent).toContain('Nothing scheduled');
    await act(async () => { cell('2026-09-16').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    await settle();
    expect(panel().querySelector('.rx-sch__day-title').textContent).toBe('Thursday, 09/17/2026');
  });

  it('month navigation requests the new range; Today returns to the current month', async () => {
    mount(); await settle();
    await click(button(/^Next month$/));
    expect(document.querySelector('.rx-sch__month').textContent).toBe('October 2026');
    expect(api.listAppointments).toHaveBeenCalledTimes(2);
    expect(api.listAppointments.mock.calls[1][0].from).not.toBe(api.listAppointments.mock.calls[0][0].from);
    await click(button(/^Today$/));
    expect(document.querySelector('.rx-sch__month').textContent).toBe('September 2026');
    expect(api.listAppointments).toHaveBeenCalledTimes(2); // cached range reused, no duplicate request
  });

  it('empty month shows a clear message; clinicians get a view-only calendar', async () => {
    auth.permissions = ['scheduling.read'];
    api.listAppointments.mockResolvedValue({ items: [], meta: { nextCursor: null } });
    mount(); await settle();
    expect(button(/^Book Appointment$/)).toBeUndefined();
    expect(document.querySelector('.rx-sch__grid-empty').textContent).toBe('No appointments in September 2026.');
    expect(panel().textContent).toContain('Nothing scheduled');
  });
});

describe('Scheduling page — Book Appointment and Reschedule update the calendar without a refresh', () => {
  it('booking calls the existing API (one clinician) and the appointment appears at once, even before the refetch returns', async () => {
    mount(); await settle();
    await click(cell('2026-09-18'));
    await click(button(/^Book$/, panel()));
    const drawer = qa('[role="dialog"]').at(-1);
    expect(drawer.getAttribute('aria-label')).toBe('Book Appointment');
    expect(drawer.querySelector('input[aria-label="Appointment date"]').value).toBe('09/18/2026'); // pre-filled from the selected date
    const selectByLabel = async (label, re) => {
      const field = qa('.rx-formfield').find((f) => f.textContent.startsWith(label));
      await click(field.querySelector('.rx-select__trigger'));
      await click(qa('.rx-select__opt').find((o) => re.test(o.textContent)));
    };
    await selectByLabel('Client', /Mia Khan/);
    await selectByLabel('BCBA', /Lovelace, Ada/);
    await click(qa('input[type="checkbox"]').find((c) => /ABA-1/.test(c.getAttribute('aria-label'))));
    expect(drawer.querySelector('.rx-bk__summary').textContent).toContain('Mia Khan');

    api.bookAppointment.mockResolvedValue({ id: 'a-new', clientId: 'c1', bcbaId: 's1', rbtId: null, staffProfileId: 's1', status: 'SCHEDULED', timeSet: false, startAt: mid(2026, 9, 18), endAt: mid(2026, 9, 19), units: 4, authorizationIds: ['svc:1'], version: 1 });
    api.listAppointments.mockImplementation(() => new Promise(() => {})); // background refetch never returns
    await click(button(/^Book Appointment$/, drawer));

    expect(api.bookAppointment).toHaveBeenCalledTimes(1);
    const body = api.bookAppointment.mock.calls[0][0];
    expect(body).toEqual({ clientId: 'c1', bcbaId: 's1', authorizationIds: ['svc:1'], startDate: '2026-09-18', endDate: '2026-09-18', units: 4 });
    expect(body).not.toHaveProperty('rbtId');
    expect(document.body.textContent).toContain('Appointment created successfully.');
    expect(panel().querySelector('.rx-sch__day-title').textContent).toBe('Friday, 09/18/2026');
    expect(cards()).toHaveLength(1);
    expect(cards()[0].className).toContain('is-new');
    expect(cards()[0].querySelector('.rx-sch__appt-client').textContent).toBe('Mia Khan');
    expect(cell('2026-09-18').getAttribute('aria-label')).toContain('1 appointment');
  });

  it('the server’s refusal is shown in the booking form, which stays open', async () => {
    mount(); await settle();
    await click(button(/^Book Appointment$/));
    const drawer = qa('[role="dialog"]').at(-1);
    await click(button(/^Book Appointment$/, drawer));
    expect(drawer.querySelector('[role="alert"]').textContent).toBe('Please complete: client, clinician, authorization.');
    expect(drawer.querySelector('.rx-bk__step.is-invalid')).toBeTruthy();
    expect(api.bookAppointment).not.toHaveBeenCalled();
  });

  it('reschedule (date-only) sends org-midnight bounds with the version and moves the card immediately', async () => {
    api.getAppointment.mockImplementation(async (id) => APPTS().find((a) => a.id === id));
    mount(); await settle();
    await click(button(/^Reschedule$/, cards()[1]));
    const drawer = qa('[role="dialog"]').at(-1);
    expect(drawer.getAttribute('aria-label')).toBe('Reschedule Appointment');
    expect(drawer.textContent).toContain('Date-only appointment');
    expect(drawer.querySelector('input[type="time"]')).toBeNull();
    await setInput(drawer.querySelector('input[aria-label="Start date"]'), '09/21/2026');
    await setInput(drawer.querySelector('input[aria-label="End date"]'), '09/22/2026');
    api.updateAppointment.mockImplementation(async (id, b) => ({ ...APPTS()[1], ...b, version: 2 }));
    api.listAppointments.mockImplementation(() => new Promise(() => {}));
    await click(button(/^Update Appointment$/, drawer));

    expect(api.updateAppointment).toHaveBeenCalledWith('a-date', { startAt: mid(2026, 9, 21), endAt: mid(2026, 9, 23) }, 1);
    expect(qa('[role="dialog"]')).toHaveLength(0);
    expect(panel().querySelector('.rx-sch__day-title').textContent).toBe('Monday, 09/21/2026');
    expect(cards().map((c) => c.querySelector('.rx-sch__appt-client').textContent)).toEqual(['Sam Torres']);
    expect(cell('2026-09-14').getAttribute('aria-label')).toContain('1 appointment');
    expect(cell('2026-09-22').getAttribute('aria-label')).toContain('1 appointment');
  });

  it('reschedule (timed) edits times in the organization timezone; server errors are shown', async () => {
    api.getAppointment.mockImplementation(async (id) => APPTS().find((a) => a.id === id));
    mount(); await settle();
    await click(button(/^Reschedule$/, cards()[0]));
    const drawer = qa('[role="dialog"]').at(-1);
    expect(drawer.querySelector('input[aria-label="Scheduled start"]').value).toBe('09:00');
    expect(drawer.querySelector('input[aria-label="Scheduled end"]').value).toBe('10:00');
    await setInput(drawer.querySelector('input[aria-label="Scheduled start"]'), '13:30');
    await setInput(drawer.querySelector('input[aria-label="Scheduled end"]'), '14:30');
    api.updateAppointment.mockRejectedValue({ response: { status: 422, data: { error: { code: 'BCBA_NOT_ASSIGNED', message: 'The selected BCBA is not assigned to this client.' } } } });
    await click(button(/^Update Appointment$/, drawer));
    expect(api.updateAppointment).toHaveBeenCalledWith('a-timed', { startAt: at(2026, 9, 14, 13, 30), endAt: at(2026, 9, 14, 14, 30) }, 3);
    expect(drawer.querySelector('[role="alert"]').textContent).toContain('The selected BCBA is not assigned to this client.');
    await setInput(drawer.querySelector('input[aria-label="Scheduled end"]'), '13:00');
    await click(button(/^Update Appointment$/, drawer));
    expect(drawer.textContent).toContain('The end time must be after the start time.');
    expect(api.updateAppointment).toHaveBeenCalledTimes(1);
  });
});

describe('Scheduling calendar — hover zoom CSS', () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../styles/redesign.css'), 'utf8');
  const rule = (selector) => {
    const i = css.indexOf(`${selector} {`);
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };
  it('hover scales the cell subtly with a transform transition (no size/margin change)', () => {
    const hover = rule('.rx-sch__cell:hover');
    const scale = Number(/scale\(([\d.]+)\)/.exec(hover)?.[1]);
    expect(scale).toBeGreaterThanOrEqual(1.02);
    expect(scale).toBeLessThanOrEqual(1.04);
    expect(hover).not.toMatch(/\b(width|height|margin|padding)\s*:/);
    expect(rule('.rx-sch__cell')).toMatch(/transition: transform/);
  });
  it('reduced motion turns the zoom and transitions off', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .rx-sch__cell'));
    expect(block).toMatch(/\.rx-sch__cell, \.rx-sch__grid \{ transition: none; \}/);
    expect(block).toMatch(/\.rx-sch__cell:hover, \.rx-sch__cell:active \{ transform: none; \}/);
  });
});
