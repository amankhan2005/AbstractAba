import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ToastProvider } from '@/components';
import { zonedWallTimeToUtc } from '@/lib/businessDate';

/**
 * APPOINTMENT DETAILS — role-based actions and the redesigned page.
 *   Company Admin: Reschedule + Cancel, never "Start session" (sessions.write alone
 *   does not decide it). BCBA clinician: the existing Start session flow.
 *   Loads from the URL alone (direct navigation), with one detail request.
 */
const TZ = 'America/New_York';
const mid = (y, m, d) => zonedWallTimeToUtc(y, m, d, 0, 0, 0, TZ).toISOString();
const at = (y, m, d, hh, mm = 0) => zonedWallTimeToUtc(y, m, d, hh, mm, 0, TZ).toISOString();

const auth = vi.hoisted(() => ({ status: 'authenticated', roles: [], permissions: [] }));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ status: auth.status, principal: auth.status === 'authenticated' ? { roles: auth.roles, permissions: auth.permissions } : null }),
  useOrgTimezone: () => 'America/New_York',
}));
const api = vi.hoisted(() => ({
  getAppointment: vi.fn(), cancelAppointment: vi.fn(), startBcbaSession: vi.fn(), listClients: vi.fn(), listStaff: vi.fn(),
  getAppointmentNote: vi.fn(), saveAppointmentNote: vi.fn(), deleteAppointmentNote: vi.fn(),
}));
vi.mock('@/api/client', () => Object.fromEntries(Object.keys(api).map((k) => [k, (...a) => api[k](...a)])));

const ADMIN = { roles: ['org_admin'], permissions: ['scheduling.read', 'scheduling.write', 'sessions.read', 'sessions.write', 'clients.read', 'documents.read'] };
const BCBA = { roles: ['bcba'], permissions: ['scheduling.read', 'sessions.write', 'clients.read', 'documents.read', 'documents.write'] };
const RBT = { roles: ['rbt'], permissions: ['scheduling.read', 'sessions.write', 'clients.read'] };
const DATE_ONLY = { id: 'appt-1', clientId: 'c-1', clientName: 'Raymond K', bcbaId: 'bcba-1', bcbaName: 'Test1 J', rbtId: null, staffProfileId: 'bcba-1', staffName: 'Test1 J',
  status: 'SCHEDULED', timeSet: false, startAt: mid(2026, 9, 12), endAt: mid(2026, 9, 13), units: 4, serviceCode: 'ABA', authorizationIds: ['svc:1'], notes: null, version: 2 };
const TIMED = { ...DATE_ONLY, id: 'appt-2', timeSet: true, startAt: at(2026, 9, 14, 9), endAt: at(2026, 9, 14, 10, 30), rbtId: 'rbt-1', rbtName: 'Nia Patel', bcbaId: null, bcbaName: null, notes: 'Bring the visual schedule.' };

let host; let root; let loc; let consoleErrorSpy; let AppointmentDetailPage; let appointmentActions;
function Probe() { loc = useLocation(); return null; }
const as = (who) => Object.assign(auth, { status: 'authenticated' }, who);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at(2026, 9, 14, 11)));
  consoleErrorSpy = vi.spyOn(console, 'error');
  for (const fn of Object.values(api)) fn.mockReset();
  api.getAppointmentNote.mockResolvedValue({ exists: false, note: null, canEdit: false });
  as(ADMIN);
  ({ AppointmentDetailPage, appointmentActions } = await import('./AppointmentDetailPage.jsx'));
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined;
  vi.useRealTimers();
  const w = consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
  consoleErrorSpy.mockRestore();
  expect(w).toHaveLength(0);
});

const mount = (id = 'appt-1') => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <MemoryRouter initialEntries={[`/scheduling/appointments/${id}`]}>
        <Probe />
        <Routes>
          <Route path="/scheduling/appointments/:appointmentId" element={<AppointmentDetailPage />} />
          <Route path="*" element={<div>other page</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  ));
};
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const buttons = () => [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
const button = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }); await settle(); };
const row = (label) => [...document.querySelectorAll('.rx-ad__row')].find((r) => r.querySelector('dt').textContent === label)?.querySelector('dd').textContent;

describe('Appointment Details — Company Admin', () => {
  it('direct URL loads the real appointment in one request; admin sees Reschedule and Cancel, never Start session', async () => {
    api.getAppointment.mockResolvedValue(DATE_ONLY);
    mount(); await settle();
    expect(api.getAppointment).toHaveBeenCalledTimes(1);
    expect(api.getAppointment).toHaveBeenCalledWith('appt-1');
    expect(api.listClients).not.toHaveBeenCalled();
    expect(api.listStaff).not.toHaveBeenCalled();
    expect(document.querySelector('.rx-ad__eyebrow').textContent).toBe('Appointment');
    expect(document.querySelector('h1').textContent).toBe('Raymond K');
    expect(document.querySelector('.rx-ad__hero .rx-badge').textContent).toBe('Scheduled');
    expect(document.body.textContent).not.toMatch(/Start session|Resume session/);
    expect(buttons()).not.toContain('Start session');
    const reschedule = [...document.querySelectorAll('.rx-ad__actions a')].find((l) => l.textContent === 'Reschedule');
    expect(reschedule.getAttribute('href')).toBe('/scheduling/appointments/appt-1/edit');
    expect(button(/^Cancel$/)).toBeTruthy();
  });

  it('date-only appointments show the business date and no fabricated midnight time', async () => {
    api.getAppointment.mockResolvedValue(DATE_ONLY);
    mount(); await settle();
    expect(document.body.textContent).not.toMatch(/12:00 AM/);
    expect(document.querySelector('.rx-ad__when').textContent).toBe('Saturday, 09/12/2026');
    expect(row('Scheduled Date')).toBe('Saturday, 09/12/2026');
    expect(row('Scheduled Time')).toBe('No clock time — date-only appointment');
    expect(row('Units')).toBe('4 (1 hour)');
    expect(row('Service Code')).toBe('ABA');
    expect(row('Authorizations')).toBe('1 authorization');
    expect(row('Notes')).toBeUndefined(); // no empty notes row
    expect([...document.querySelectorAll('.rx-ad__fact')].map((f) => f.textContent)).toEqual(['Scheduled DateSaturday, 09/12/2026', 'Scheduled TimeDate-only appointment', 'Units4 units · 1 h', 'Service CodeABA']);
  });

  it('timed appointments show the persisted time in the organization timezone; client link, staff role and notes render', async () => {
    api.getAppointment.mockResolvedValue(TIMED);
    mount('appt-2'); await settle();
    expect(document.querySelector('.rx-ad__when').textContent).toBe('Monday, 09/14/20269:00 AM – 10:30 AM');
    expect(row('Scheduled Time')).toBe('9:00 AM – 10:30 AM');
    expect(row('Notes')).toBe('Bring the visual schedule.');
    expect(document.querySelector('.rx-ad__link').getAttribute('href')).toBe('/clients/c-1');
    expect([...document.querySelectorAll('.rx-ad__staff .rx-ad__person-text')].map((p) => p.textContent)).toEqual(['Nia PatelRBT']);
    await click(document.querySelector('.rx-ad__link'));
    expect(loc.pathname).toBe('/clients/c-1');
  });

  it('Cancel confirms, calls the existing API and updates the page without a refresh', async () => {
    api.getAppointment.mockResolvedValue(DATE_ONLY);
    api.cancelAppointment.mockResolvedValue({ ...DATE_ONLY, status: 'CANCELLED', version: 3 });
    mount(); await settle();
    await click(button(/^Cancel$/));
    expect(document.querySelector('[role="dialog"]').textContent).toContain('The appointment for Raymond K on Saturday, 09/12/2026 will be cancelled.');
    expect(api.cancelAppointment).not.toHaveBeenCalled();
    api.getAppointment.mockImplementation(() => new Promise(() => {})); // refetch pending: the page must already show the result
    await click(button(/^Cancel Appointment$/));
    expect(api.cancelAppointment).toHaveBeenCalledWith('appt-1');
    expect(document.querySelector('.rx-ad__hero .rx-badge').textContent).toBe('Cancelled');
    expect(document.querySelector('.rx-ad__actions')).toBeNull(); // nothing left to reschedule or cancel
    expect(document.body.textContent).toContain('Appointment cancelled.');
  });

  it('no actions appear until permissions are known (no half-rendered action bar)', async () => {
    auth.status = 'unknown';
    api.getAppointment.mockResolvedValue(DATE_ONLY);
    mount(); await settle();
    expect(document.querySelector('.rx-ad__actions')).toBeNull();
    expect(document.querySelector('h1').textContent).toBe('Raymond K');
  });
});

describe('BUG FIX — Company Admin never sees or triggers Start/Resume session', () => {
  const OWNER = { roles: ['owner'], permissions: ADMIN.permissions };

  for (const [label, who] of [['Company Admin (org_admin)', ADMIN], ['Owner', OWNER]]) {
    it(`${label}: Start session is not rendered (scheduled) and Resume session is not rendered (in progress)`, async () => {
      as(who);
      api.getAppointment.mockResolvedValue({ ...DATE_ONLY, startAt: mid(2026, 9, 14), endAt: mid(2026, 9, 15) }); // startable today
      mount(); await settle();
      expect(appointmentActions({ roles: who.roles, can: (k) => who.permissions.includes(k), appointment: DATE_ONLY }).startSession).toBe(false);
      expect([...document.querySelectorAll('button, a')].some((b) => /start session|resume session/i.test(b.textContent))).toBe(false);
      expect([...document.querySelectorAll('.rx-ad__actions a, .rx-ad__actions button')].map((b) => b.textContent.trim())).toEqual(['Reschedule', 'Cancel']);
      act(() => root.unmount()); host.remove(); root = undefined;

      api.getAppointment.mockResolvedValue({ ...DATE_ONLY, status: 'IN_PROGRESS', startAt: mid(2026, 9, 14), endAt: mid(2026, 9, 15) });
      mount(); await settle();
      expect(document.body.textContent).not.toMatch(/start session|resume session/i);
    });
  }

  it('Company Admin cannot invoke the start action through the UI: activating every control never calls the session API', async () => {
    api.getAppointment.mockResolvedValue({ ...DATE_ONLY, startAt: mid(2026, 9, 14), endAt: mid(2026, 9, 15) });
    api.cancelAppointment.mockReturnValue(new Promise(() => {}));
    mount(); await settle();
    for (const el of [...document.querySelectorAll('button')].filter((b) => !/^Cancel$/.test(b.textContent.trim()))) {
      await click(el);
    }
    expect(api.startBcbaSession).not.toHaveBeenCalled();
    expect(loc.pathname).not.toBe('/sessions/panel');
  });

  it('BCBA on an in-progress appointment still sees Resume session', async () => {
    as(BCBA);
    api.getAppointment.mockResolvedValue({ ...DATE_ONLY, status: 'IN_PROGRESS', startAt: mid(2026, 9, 14), endAt: mid(2026, 9, 15) });
    mount(); await settle();
    expect(button(/^Resume session$/)).toBeTruthy();
    expect(button(/^Resume session$/).disabled).toBe(false);
  });
});

describe('Appointment Details — clinicians keep the existing session start', () => {
  it('BCBA sees Start session (not Reschedule/Cancel) and starts through the existing endpoint', async () => {
    as(BCBA);
    api.getAppointment.mockResolvedValue({ ...DATE_ONLY, startAt: mid(2026, 9, 14), endAt: mid(2026, 9, 15) });
    api.startBcbaSession.mockResolvedValue({ id: 's-1' });
    mount(); await settle();
    expect(button(/^Start session$/)).toBeTruthy();
    expect(buttons()).not.toContain('Cancel');
    expect(document.querySelector('.rx-ad__actions a')).toBeNull();
    await click(button(/^Start session$/));
    expect(api.startBcbaSession).toHaveBeenCalledWith('appt-1');
    expect(loc.pathname).toBe('/sessions/panel');
  });

  it('a future BCBA appointment shows Start session disabled with the start-window label', async () => {
    as(BCBA);
    api.getAppointment.mockResolvedValue({ ...DATE_ONLY, startAt: mid(2026, 9, 20), endAt: mid(2026, 9, 21) });
    mount(); await settle();
    expect(button(/^Start session$/).disabled).toBe(true);
    expect(document.querySelector('.rx-ad__hint')).toBeTruthy();
  });

  it('the rule itself: Company Admin (even with sessions.write, or also holding BCBA) never gets Start session; RBT uses the RBT panel', () => {
    const can = (perms) => (k) => perms.includes(k);
    expect(appointmentActions({ roles: ADMIN.roles, can: can(ADMIN.permissions), appointment: DATE_ONLY })).toEqual({ reschedule: true, cancel: true, startSession: false, viewClient: true });
    expect(appointmentActions({ roles: ['org_admin', 'bcba'], can: can([...ADMIN.permissions]), appointment: DATE_ONLY }).startSession).toBe(false);
    expect(appointmentActions({ roles: ['owner'], can: can(ADMIN.permissions), appointment: DATE_ONLY }).startSession).toBe(false);
    expect(appointmentActions({ roles: BCBA.roles, can: can(BCBA.permissions), appointment: DATE_ONLY })).toEqual({ reschedule: false, cancel: false, startSession: true, viewClient: true });
    expect(appointmentActions({ roles: BCBA.roles, can: can(BCBA.permissions), appointment: { ...DATE_ONLY, bcbaId: null } }).startSession).toBe(false);
    expect(appointmentActions({ roles: RBT.roles, can: can(RBT.permissions), appointment: { ...DATE_ONLY, rbtId: 'r' } }).startSession).toBe(false);
    expect(appointmentActions({ roles: ADMIN.roles, can: can(ADMIN.permissions), appointment: { ...DATE_ONLY, status: 'COMPLETED' } })).toMatchObject({ reschedule: false, cancel: false });
  });
});

describe('Appointment Details — states', () => {
  it('shows a loading skeleton, then a not-found state for 404, and an error with retry for other failures', async () => {
    api.getAppointment.mockReturnValue(new Promise(() => {}));
    mount(); await settle(5);
    expect(document.querySelector('[aria-label="Loading appointment"]')).toBeTruthy();
    act(() => root.unmount()); host.remove(); root = undefined;

    api.getAppointment.mockRejectedValue({ response: { status: 404 } });
    mount(); await settle();
    expect(document.querySelector('h1').textContent).toBe('Appointment not found');
    act(() => root.unmount()); host.remove(); root = undefined;

    api.getAppointment.mockRejectedValueOnce({ response: { status: 500 } }).mockResolvedValue(DATE_ONLY);
    mount(); await settle();
    expect(document.querySelector('h1').textContent).toBe('We couldn’t load this appointment');
    await click(button(/^Try again$/));
    expect(document.querySelector('h1').textContent).toBe('Raymond K');
  });
});
