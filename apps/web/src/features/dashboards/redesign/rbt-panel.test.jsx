import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * RBT panel (the enhanced RBT dashboard). Verifies the spec's RBT workflow at
 * the UI boundary: a personalized greeting with the real first name; the
 * ongoing-session hero pinned at the top when a session is running (and absent
 * when none is); assigned sessions with a Start button that calls the real RBT
 * start API; and a "My Hours" card that defaults to This Week, exposes all six
 * period filters, shows exact h/m/s, and never shows money.
 */

const CHILD = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const APPT = '01a051e4-c8fd-71a1-b09e-3e86422eb6c2';

const getRbtDashboard = vi.fn(() => Promise.resolve({
  assignedClients: 2, todaysSessions: 1, upcomingAppointments: 3, draftSessions: 0,
  submittedSessions: 0, frozenSessions: 0, sessionCompletion: { completionPercent: 0, completed: 0, total: 0 },
}));
const getRbtPanel = vi.fn();
const startRbtSession = vi.fn(() => Promise.resolve({ id: 'sess-1', status: 'IN_PROGRESS' }));
const stopRbtSession = vi.fn();
const completeRbtSession = vi.fn();
const getRbtMyHours = vi.fn();
const getRbtChildDetail = vi.fn(() => Promise.resolve({ child: { firstName: 'Ada' }, appointment: { authorizations: [] }, activePlan: null, session: { status: 'IN_PROGRESS' } }));
const listClients = vi.fn(() => Promise.resolve({ items: [] }));
const listStaff = vi.fn(() => Promise.resolve({ items: [] }));

vi.mock('@/api/client', () => ({
  getRbtDashboard: (...a) => getRbtDashboard(...a),
  getRbtPanel: (...a) => getRbtPanel(...a),
  startRbtSession: (...a) => startRbtSession(...a),
  stopRbtSession: (...a) => stopRbtSession(...a),
  completeRbtSession: (...a) => completeRbtSession(...a),
  getRbtMyHours: (...a) => getRbtMyHours(...a),
  getRbtChildDetail: (...a) => getRbtChildDetail(...a),
  getBcbaChildDetail: (...a) => getRbtChildDetail(...a),
  saveRbtSessionDocumentation: vi.fn(() => Promise.resolve({})),
  saveBcbaSessionDocumentation: vi.fn(() => Promise.resolve({})),
  getBcbaPanel: () => Promise.resolve([]),
  listClients: (...a) => listClients(...a),
  listStaff: (...a) => listStaff(...a),
}));
const auth = vi.hoisted(() => ({ fullName: 'Jordan Rivera' }));
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { user: { fullName: auth.fullName }, permissions: ['dashboards.read', 'sessions.write'] } }), useOrgTimezone: () => 'UTC' }));

let host; let root; let RbtDashboardPage;
const scheduled = [{ appointmentId: APPT, clientId: CHILD, childName: 'Ada Byron', startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3.6e6).toISOString(), authorizationIds: ['a1'], sessionStatus: 'SCHEDULED', canStart: true, isRunning: false }];
const runningCard = [{ appointmentId: APPT, clientId: CHILD, childName: 'Ada Byron', startAt: new Date(Date.now() - 5000).toISOString(), endAt: new Date(Date.now() + 3.6e6).toISOString(), authorizationIds: ['a1'], sessionStatus: 'IN_PROGRESS', canStart: false, isRunning: true, startedAt: new Date(Date.now() - 5000).toISOString() }];

beforeEach(async () => {
  ({ RbtDashboardPage } = await import('./RbtDashboardPage.jsx'));
  auth.fullName = 'Jordan Rivera';
  getRbtPanel.mockReset(); startRbtSession.mockClear(); getRbtMyHours.mockReset();
  getRbtMyHours.mockResolvedValue({ period: 'week', totalSeconds: 3723, hours: 1, minutes: 2, seconds: 3, text: '1h 02m 03s', sessionCount: 2 });
});
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={['/dashboards/rbt']}><RbtDashboardPage /></MemoryRouter></QueryClientProvider>,
  ));
};
const waitFor = async (re, scope = () => host.textContent) => { for (let i = 0; i < 80; i += 1) { if (re.test(scope())) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found in: ${scope().slice(0, 400)}`); };

describe('RbtDashboardPage (RBT panel)', () => {
  // The personalised greeting ("Good morning, <First name>") intentionally lives
  // in the role SHELL topbar (RbtShell), not on the RBT dashboard PAGE. Greeting
  // + first-name capitalization are covered by shells/shell-greeting.test.jsx.
  // The page renders here WITHOUT its shell, so the greeting is not asserted here.

  it('disables Start and shows EXPIRED once the 24-hour start window has closed', async () => {
    // Started 48h ago → its 24-hour window closed 24h ago, whatever the time of day.
    const y = new Date(Date.now() - 48 * 3.6e6);
    getRbtPanel.mockResolvedValue([{ appointmentId: APPT, clientId: CHILD, childName: 'Ada Byron', startAt: new Date(y.getFullYear(), y.getMonth(), y.getDate(), 10).toISOString(), endAt: new Date(y.getFullYear(), y.getMonth(), y.getDate(), 11).toISOString(), authorizationIds: ['a1'], sessionStatus: 'SCHEDULED', canStart: true, isRunning: false }]);
    mount();
    await waitFor(/Ada Byron/);
    const startBtn = [...host.querySelectorAll('button')].find((b) => /Start session/i.test(b.textContent));
    expect(startBtn).toBeTruthy();
    expect(startBtn.disabled).toBe(true);           // grey / non-clickable
    expect(host.textContent).toMatch(/Expired — start window closed \d{2}\/\d{2}\/\d{4}/); // friendly, MM/DD/YYYY, not the error code
    expect([...host.querySelectorAll('.rx-badge')].some((b) => /Expired/.test(b.textContent))).toBe(true);
    expect(host.textContent).not.toMatch(/APPOINTMENT_NOT_TODAY/);
  });

  it('shows assigned sessions with a Start button and calls the real RBT start API', async () => {
    getRbtPanel.mockResolvedValue(scheduled);
    mount();
    await waitFor(/Ada Byron/);
    const startBtn = [...host.querySelectorAll('button')].find((b) => /Start session/i.test(b.textContent));
    expect(startBtn).toBeTruthy();
    await act(async () => { startBtn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(startRbtSession).toHaveBeenCalledWith(APPT);
  });

  it('pins the ongoing-session hero at the top when a session is running', async () => {
    getRbtPanel.mockResolvedValue(runningCard);
    mount();
    await waitFor(/Session in progress/);
    expect(host.textContent).toContain('Ada Byron');
    expect(host.textContent).toContain('Stop session');
  });

  it('does NOT render an ongoing-session hero when nothing is running', async () => {
    getRbtPanel.mockResolvedValue(scheduled);
    mount();
    await waitFor(/Ada Byron/);
    expect(host.textContent).not.toContain('Session in progress');
  });

  it('My Hours defaults to This Week, shows exact h/m/s, offers all six filters, and shows no money', async () => {
    getRbtPanel.mockResolvedValue(scheduled);
    mount();
    await waitFor(/My Hours/);
    await waitFor(/1h 02m 03s/);
    for (const label of ['This Week', 'This Bi-Week', 'This Month', '3 Months', '6 Months', '1 Year']) {
      expect(host.textContent).toContain(label);
    }
    expect(getRbtMyHours).toHaveBeenCalledWith('week');
    expect(host.textContent).not.toContain('$');
    expect(host.textContent.toLowerCase()).not.toContain('rate');
    expect(host.textContent.toLowerCase()).not.toContain('payroll');
  });

  it('switching the My Hours filter refetches for the chosen period', async () => {
    getRbtPanel.mockResolvedValue(scheduled);
    mount();
    await waitFor(/My Hours/);
    const monthBtn = [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === 'This Month');
    await act(async () => { monthBtn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(getRbtMyHours).toHaveBeenCalledWith('month');
  });
});

describe('RbtDashboardPage — multi-date appointment (09/12/2026 → 09/30/2026) on 09/13/2026', () => {
  const RANGE = { appointmentId: APPT, clientId: CHILD, childName: 'Raymond K', timeSet: false,
    startAt: '2026-09-12T00:00:00.000Z', endAt: '2026-10-01T00:00:00.000Z', authorizationIds: [], canStart: true, isRunning: false };
  afterEach(() => { vi.useRealTimers(); });

  it('Start Session represents the 09/13 occurrence, never 09/12 or the whole range', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T15:00:00Z'));
    getRbtPanel.mockResolvedValue([{ ...RANGE, sessionStatus: 'SCHEDULED', startStatus: 'AVAILABLE', startBusinessDate: '2026-09-13' }]);
    mount();
    await waitFor(/Start a session/);
    const row = [...host.querySelectorAll('.rx-row')].find((r) => /Start Session/.test(r.textContent));
    expect(row.querySelector('.rx-row__meta').textContent).toBe('09/13/2026 · Start by 09/13/2026 11:59 PM');
    expect(host.textContent).not.toContain('09/12/2026');
    expect(host.textContent).not.toContain('09/30/2026');
  });

  it('a session stopped on 09/12 is NOT offered on 09/13: shown expired, Start disabled, Finish still available', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T15:00:00Z'));
    getRbtPanel.mockResolvedValue([{ ...RANGE, sessionStatus: 'STOPPED', canResume: true, sessionBusinessDate: '2026-09-12', startBusinessDate: '2026-09-12', startStatus: 'EXPIRED', expired: true, startableNow: false }]);
    mount();
    await waitFor(/Expired — start window closed 09\/13\/2026 12:00 AM/);
    expect([...host.querySelectorAll('button')].some((b) => /^Start Session$/.test(b.textContent.trim()) && b.getAttribute('aria-label'))).toBe(false);
    expect(host.textContent).not.toMatch(/Start by 09\/13\/2026 11:59 PM/);
    const start = [...host.querySelectorAll('button')].find((b) => /^Start session$/.test(b.textContent.trim()));
    expect(start.disabled).toBe(true);
    expect([...host.querySelectorAll('button')].some((b) => /Finish session/.test(b.textContent))).toBe(true);
  });
});
