import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * COMPANY SESSIONS + SESSION DETAIL — data flow, first-click navigation and
 * direct URLs, against the real page components and the real routes.
 */
const TZ = 'America/New_York';
const api = vi.hoisted(() => ({
  listSessions: vi.fn(), getSession: vi.fn(), listClients: vi.fn(), listStaff: vi.fn(),
  clockInSession: vi.fn(), clockOutSession: vi.fn(), submitSession: vi.fn(), freezeSession: vi.fn(), returnSession: vi.fn(), cancelSession: vi.fn(), amendSession: vi.fn(),
}));
vi.mock('@/api/client', () => Object.fromEntries(Object.keys(api).map((k) => [k, (...a) => api[k](...a)])));
const auth = vi.hoisted(() => ({ roles: ['org_admin'], permissions: ['sessions.read', 'sessions.write', 'sessions.review'] }));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ status: 'authenticated', principal: { roles: auth.roles, permissions: auth.permissions } }),
  useOrgTimezone: () => 'America/New_York',
}));
vi.mock('@/components', () => ({ useToast: () => ({ push: () => {} }) }));

const ID1 = '01a09fea-64dd-7b7e-8f77-798c4f77892d';
const ID2 = '01a09fea-64ce-7675-bc89-9d1a4852ad52';
const ROWS = [
  { id: ID1, clientId: 'c1', staffProfileId: 's1', status: 'FROZEN', source: 'MANUAL', childName: 'Sam Torres', clinicianName: 'Nia Patel', role: 'RBT',
    startedAt: '2026-09-13T22:15:00.000Z', endedAt: '2026-09-13T23:45:00.000Z', actualStart: '2026-09-13T22:15:00.000Z', actualEnd: '2026-09-13T23:45:00.000Z', workedMinutes: 90 },
  { id: ID2, clientId: 'c2', staffProfileId: 's2', status: 'IN_PROGRESS', childName: 'Mia Khan', clinicianName: 'Test1 J', role: 'BCBA',
    startedAt: '2026-09-14T14:00:00.000Z', endedAt: null, actualStart: '2026-09-14T14:00:00.000Z', actualEnd: null, workedMinutes: null },
  { id: 'r3', clientId: 'c2', staffProfileId: 's2', status: 'SUBMITTED', childName: 'Mia Khan', clinicianName: 'Test1 J', role: 'BCBA',
    startedAt: '2026-09-10T14:00:00.000Z', endedAt: '2026-09-10T15:00:00.000Z', workedMinutes: 60 },
  { id: 'r4', clientId: 'c3', staffProfileId: 's1', status: 'RETURNED', childName: 'Eve Evans', clinicianName: 'Nia Patel', role: 'RBT',
    startedAt: '2026-09-09T14:00:00.000Z', endedAt: '2026-09-09T14:45:00.000Z', workedMinutes: 45 },
];
const DETAIL = (id) => ({
  session: { id, clientId: 'c1', staffProfileId: 's1', status: 'FROZEN', source: 'MANUAL', startedAt: ROWS[0].startedAt, endedAt: ROWS[0].endedAt, clockInAt: ROWS[0].startedAt, clockOutAt: ROWS[0].endedAt, narrative: 'Worked on requesting.',
    intervals: [{ startedAt: ROWS[0].startedAt, endedAt: ROWS[0].endedAt, workedMinutes: 90 }] },
  dataPoints: [],
  appointment: { startAt: ROWS[0].startedAt, endAt: ROWS[0].endedAt, timeSet: true, rbtId: 's1', units: 6, authorizations: [{ id: 'a1', label: 'ABA · 97153' }], selectedAuthorization: { id: 'a1', label: 'ABA · 97153' } },
  // Authoritative worked minutes deliberately differ from end − start, to prove which one is shown.
  payroll: { workedMinutes: 84 },
  display: { childName: 'Sam Torres', bcbaName: null, rbtName: 'Nia Patel', treatmentPlanName: 'Functional Communication Plan' },
});

let host; let root; let qc; let loc; let nav; let consoleErrorSpy; let SessionsIndexRoute; let SessionDetailRedesign;
function Probe() { loc = useLocation(); nav = useNavigate(); return null; }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T16:00:00.000Z'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  for (const fn of Object.values(api)) fn.mockReset();
  auth.roles = ['org_admin']; auth.permissions = ['sessions.read', 'sessions.write', 'sessions.review'];
  api.listSessions.mockResolvedValue({ items: ROWS, meta: { nextCursor: null } });
  api.getSession.mockImplementation(async (id) => DETAIL(id));
  api.listClients.mockResolvedValue({ items: [{ id: 'c1', firstName: 'Sam', lastName: 'Torres' }, { id: 'c2', firstName: 'Mia', lastName: 'Khan' }] });
  api.listStaff.mockResolvedValue({ items: [{ id: 's1', firstName: 'Nia', lastName: 'Patel' }] });
  ({ SessionsIndexRoute } = await import('./SessionsIndexRoute.jsx'));
  ({ SessionDetailRedesign } = await import('./SessionDetailRedesign.jsx'));
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined;
  vi.useRealTimers();
  const w = consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
  consoleErrorSpy.mockRestore();
  expect(w).toHaveLength(0);
});

const mount = (path = '/sessions') => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Probe />
        <Routes>
          <Route path="/sessions" element={<SessionsIndexRoute />} />
          <Route path="/sessions/oversight" element={<div>insights</div>} />
          <Route path="/sessions/:sessionId" element={<SessionDetailRedesign />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
};
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const rows = () => [...host.querySelectorAll('.rx-ss__row-link')];
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); }); await settle(); };
const selectByPlaceholder = async (placeholder, re) => {
  const trigger = [...host.querySelectorAll('.rx-select__trigger')].find((t) => t.closest('.rx-ss__filter') && t.textContent.includes(placeholder));
  await click(trigger);
  await click([...document.querySelectorAll('.rx-select__opt')].find((o) => re.test(o.textContent)));
};
const detailRow = (label) => [...host.querySelectorAll('.rx-sd__row')].find((r) => r.querySelector('dt').textContent === label)?.querySelector('dd').textContent;

describe('Company Sessions page', () => {
  it('loads real sessions with ONE list request on open; removed review cards are gone; rows map the authoritative data', async () => {
    mount(); await settle();
    expect(host.querySelector('h1').textContent).toBe('Sessions');
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    expect(api.listSessions).toHaveBeenCalledWith({ limit: 50 });
    expect(api.getSession).not.toHaveBeenCalled(); // no per-row detail requests
    expect(host.textContent).not.toMatch(/Pending review|Submitted, awaiting sign-off|Sent back to the technician/);
    expect(host.querySelector('.rx-ss__stats').textContent).not.toMatch(/Returned/);
    expect([...host.querySelectorAll('.rx-ss__stat')].map((s) => s.textContent)).toEqual(['Sessions4', 'Today1', 'In progress1', 'Completed1', 'Worked time3h 15m']);
    const first = rows()[0];
    expect(first.getAttribute('href')).toBe(`/sessions/${ID1}`);
    expect(first.querySelector('.rx-ss__child').textContent).toBe('Sam Torres');
    expect(first.querySelector('.rx-ss__clinician').textContent).toBe('RBTNia Patel');
    expect(first.querySelector('.rx-ss__date').textContent).toBe('09/13/2026');
    expect(first.querySelector('.rx-ss__times').textContent).toBe('Clock-in6:15 PMClock-out7:45 PM'); // organization timezone
    expect(first.querySelector('.rx-ss__worked').textContent).toBe('Worked1h 30m');
    expect(first.textContent).toContain('Manual entry');
    expect(first.textContent).toContain('Completed');
    const live = rows()[1];
    expect(live.querySelector('.rx-ss__times').textContent).toContain('Clock-outIn progress');
    expect(live.querySelector('.rx-ss__worked').textContent).toBe('Worked—');
  });

  it('Client, Clinician and Status filters are sent to the server; search narrows the loaded rows; Clear resets', async () => {
    mount(); await settle();
    await selectByPlaceholder('All statuses', /^In progress$/);
    expect(api.listSessions).toHaveBeenLastCalledWith({ status: 'IN_PROGRESS', limit: 50 });
    await selectByPlaceholder('All clients', /Mia Khan/);
    expect(api.listSessions).toHaveBeenLastCalledWith({ status: 'IN_PROGRESS', clientId: 'c2', limit: 50 });
    await selectByPlaceholder('All clinicians', /Nia Patel/);
    expect(api.listSessions).toHaveBeenLastCalledWith({ status: 'IN_PROGRESS', clientId: 'c2', staffProfileId: 's1', limit: 50 });
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Clear filters'));
    expect(api.listSessions).toHaveBeenLastCalledWith({ limit: 50 });
    const input = host.querySelector('.rx-ss__search input');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'eve');
    await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(rows().map((r) => r.querySelector('.rx-ss__child').textContent)).toEqual(['Eve Evans']);
  });

  it('loading skeleton, error with retry, empty state, and Load more with the cursor', async () => {
    api.listSessions.mockReturnValueOnce(new Promise(() => {}));
    mount(); await settle(5);
    expect(host.querySelector('[aria-label="Loading sessions"]')).toBeTruthy();
    act(() => root.unmount()); host.remove(); root = undefined;

    api.listSessions.mockRejectedValueOnce({ response: { status: 500 } });
    mount(); await settle();
    expect(host.textContent).toContain('We couldn’t load sessions');
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again'));
    expect(rows()).toHaveLength(4);
    act(() => root.unmount()); host.remove(); root = undefined;

    api.listSessions.mockResolvedValueOnce({ items: [], meta: { nextCursor: null } });
    mount(); await settle();
    expect(host.textContent).toContain('No sessions yet');
    act(() => root.unmount()); host.remove(); root = undefined;

    api.listSessions.mockReset();
    api.listSessions.mockResolvedValueOnce({ items: ROWS.slice(0, 2), meta: { nextCursor: 'cur-2' } }).mockResolvedValueOnce({ items: ROWS.slice(2), meta: { nextCursor: null } });
    mount(); await settle();
    expect(host.querySelector('.rx-ss__scope').textContent).toContain('Summary covers the 2 most recent sessions loaded');
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Load more sessions'));
    expect(api.listSessions).toHaveBeenLastCalledWith({ limit: 50, cursor: 'cur-2' });
    expect(rows()).toHaveLength(4);
    expect(host.querySelector('.rx-ss__more')).toBeNull();
  });

  it('BCBA and RBT keep their existing Sessions page (not the Company page)', async () => {
    auth.roles = ['bcba']; auth.permissions = ['sessions.read', 'sessions.write'];
    mount(); await settle();
    expect(host.querySelector('.rx-ss')).toBeNull();
    expect(host.textContent).toContain('Review Queue');
  });
});

describe('Session Detail — first click, direct URL, not found', () => {
  it('clicking a session navigates to /sessions/:id and renders the detail immediately, with one detail request', async () => {
    mount(); await settle();
    await click(rows()[0]);
    expect(loc.pathname).toBe(`/sessions/${ID1}`);
    expect(api.getSession).toHaveBeenCalledTimes(1);
    expect(api.getSession).toHaveBeenCalledWith(ID1);
    expect(host.querySelector('.rx-sd__hero h1').textContent).toBe('Sam Torres');
    expect(detailRow('Worked Time')).toBe('1h 24m'); // authoritative SessionTimeRecord minutes, not end − start (1h 30m)
    expect(host.querySelector('.rx-sd__worked strong').textContent).toBe('1h 24m');
    expect(detailRow('Clocked in')).toBe('6:15 PM');
    expect(detailRow('Clocked out')).toBe('7:45 PM');
    expect(detailRow('Session date')).toBe('09/13/2026 · 6:15 PM – 7:45 PM');
    expect(host.textContent).toContain('Functional Communication Plan');
    expect([...host.querySelectorAll('.rx-sd__person-text')].map((p) => p.textContent)).toEqual(['Nia PatelRBT']);
    expect(host.querySelector('.rx-sp__back').textContent.trim()).toBe('Back to Sessions');
    expect(api.listSessions).toHaveBeenCalledTimes(1); // the list isn't re-requested to open a detail
  });

  it('going back and opening another session works without any refresh; revisiting a session within its freshness window is not re-requested', async () => {
    mount(); await settle();
    await click(rows()[0]);
    await act(async () => { nav(-1); }); await settle();
    expect(loc.pathname).toBe('/sessions');
    await click(rows()[1]);
    expect(loc.pathname).toBe(`/sessions/${ID2}`);
    expect(host.querySelector('.rx-sd__hero h1')).toBeTruthy();
    await act(async () => { nav(-1); }); await settle();
    await click(rows()[0]);
    expect(api.getSession.mock.calls.map((c) => c[0])).toEqual([ID1, ID2]);
  });

  it('hover prefetch warms the same query, so the click does not issue a second request', async () => {
    mount(); await settle();
    await act(async () => { rows()[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    await settle();
    expect(api.getSession).toHaveBeenCalledTimes(1);
    await click(rows()[0]);
    expect(api.getSession).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.rx-sd__hero h1').textContent).toBe('Sam Torres');
  });

  it('a direct URL loads the detail on its own (no list request, no prior state)', async () => {
    mount(`/sessions/${ID1}`); await settle();
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(api.getSession).toHaveBeenCalledWith(ID1);
    expect(host.querySelector('.rx-sd__hero h1').textContent).toBe('Sam Torres');
  });

  it('an unknown session shows Session not found; other failures offer Try again', async () => {
    api.getSession.mockRejectedValueOnce({ response: { status: 404 } });
    mount('/sessions/01a09fea-0000-7000-8000-000000000000'); await settle();
    expect(host.querySelector('.rx-sd__state-title').textContent).toBe('Session not found');
    act(() => root.unmount()); host.remove(); root = undefined;
    api.getSession.mockRejectedValueOnce({ response: { status: 500 } }).mockImplementation(async (id) => DETAIL(id));
    mount(`/sessions/${ID1}`); await settle();
    expect(host.querySelector('.rx-sd__state-title').textContent).toBe('We couldn’t load this session');
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again'));
    expect(host.querySelector('.rx-sd__hero h1').textContent).toBe('Sam Torres');
  });
});
