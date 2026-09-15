import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * BcbaDashboardPage — the Phase-3 screenshot fix. The board must now lead with a
 * personalised greeting (spec §1), the ACTIVE SESSION hero at the very top when
 * one is running (spec §C), and THIS WEEK progress (spec §K) — before the older
 * KPI board. It shows human data only: the child's NAME, never an id, and no raw
 * ISO timestamp or svc: marker anywhere in the DOM.
 */

const IDS = {
  appt: '01a051e4-c8fd-71a1-b09e-3e86422eb6c2',
  child: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  rbt: 'b1e2c3d4-e5f6-4789-abcd-0123456789ab',
  auth: 'svc:9f8e7d6c5b4a',
};

const getBcbaDashboard = vi.fn();
const getBcbaWeeklyHours = vi.fn();
const getBcbaPanel = vi.fn();
const listClients = vi.fn(() => Promise.resolve({ items: [{ id: IDS.child, firstName: 'Raymond', lastName: 'More' }] }));
const listStaff = vi.fn(() => Promise.resolve({ items: [{ id: IDS.rbt, firstName: 'Nia', lastName: 'Patel' }] }));
const getBcbaChildDetail = vi.fn(() => Promise.resolve({
  appointment: {
    startAt: new Date().toISOString(), endAt: new Date().toISOString(), rbtId: IDS.rbt,
    authorizationIds: [IDS.auth],
    authorizations: [{ id: IDS.auth, label: 'ABA Therapy — ABC Insurance — AUTH-12345', serviceCode: '97153' }],
  },
}));

vi.mock('@/api/client', () => ({
  getBcbaDashboard: (...a) => getBcbaDashboard(...a),
  getBcbaWeeklyHours: (...a) => getBcbaWeeklyHours(...a),
  getBcbaPanel: (...a) => getBcbaPanel(...a),
  listClients: (...a) => listClients(...a),
  listStaff: (...a) => listStaff(...a),
  getBcbaChildDetail: (...a) => getBcbaChildDetail(...a),
  saveBcbaSessionDocumentation: vi.fn(() => Promise.resolve({})),
}));
const auth = vi.hoisted(() => ({ fullName: 'Aman Khan' }));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ principal: { user: { fullName: auth.fullName } } }),
  useOrgTimezone: () => 'UTC',
}));

const BOARD = {
  caseloadClients: 4, pendingApprovals: 2, activeTreatmentPlans: 3, todaysSessions: 0,
  upcomingAppointments: 5, draftSessions: 1, frozenSessions: 6, credentialExpirations: 0,
  todaysSessionsByStatus: {},
};

let host; let root; let consoleErrorSpy; let BcbaDashboardPage;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

beforeEach(async () => {
  ({ BcbaDashboardPage } = await import('./BcbaDashboardPage.jsx'));
  auth.fullName = 'Aman Khan';
  consoleErrorSpy = vi.spyOn(console, 'error');
  getBcbaDashboard.mockReset(); getBcbaDashboard.mockResolvedValue(BOARD);
  getBcbaWeeklyHours.mockReset(); getBcbaWeeklyHours.mockResolvedValue({ configured: false });
  getBcbaPanel.mockReset(); getBcbaPanel.mockResolvedValue([]);
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><MemoryRouter><BcbaDashboardPage /></MemoryRouter></QueryClientProvider>,
  ));
};
const waitFor = async (re) => { for (let i = 0; i < 80; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found in: ${host.textContent.slice(0, 300)}`); };

function assertNoTechnicalIds() {
  const text = host.textContent;
  for (const [k, v] of Object.entries(IDS)) expect(text, `leaked ${k} (${v})`).not.toContain(v);
  expect(text, 'leaked a svc: transport id').not.toMatch(/svc:/);
  expect(text, 'leaked a UUID').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(text, 'leaked a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
}

describe('BcbaDashboardPage', () => {
  // The personalised greeting ("Good morning, <First name>") intentionally lives
  // in the role SHELL topbar (BcbaShell), not on the dashboard PAGE, whose header
  // is the static "Dashboard". Greeting + first-name capitalization are covered
  // by shells/shell-greeting.test.jsx. These pages render here WITHOUT their
  // shell, so the greeting is deliberately not asserted at this level.

  it('shows a scannable today-by-state breakdown with a total and friendly labels — "Approved", never raw "Frozen" (spec §5/§6)', async () => {
    getBcbaDashboard.mockResolvedValue({ ...BOARD, todaysSessions: 5, todaysSessionsByStatus: { DRAFT: 2, IN_PROGRESS: 1, FROZEN: 2 } });
    mount();
    await waitFor(/Total: 5 sessions today/);
    const t = host.textContent;
    expect(t).toContain('Total: 5 sessions today');
    expect(t).toContain('Approved');
    expect(t).toContain('In progress');
    expect(t).toContain('Scheduled');
    expect(t).toContain('No show');       // canonical zero-filled state still shown
    expect(t).not.toMatch(/\bFrozen\b/i);
  });

  it('uses singular wording for a single session today', async () => {
    getBcbaDashboard.mockResolvedValue({ ...BOARD, todaysSessions: 1, todaysSessionsByStatus: { FROZEN: 1 } });
    mount();
    await waitFor(/Total: 1 session today/);
    expect(host.textContent).toContain('Total: 1 session today');
  });

  it('shows the ACTIVE SESSION hero at the top when one is running, with human data (spec §C)', async () => {
    const started = new Date(Date.now() - 26 * 60 * 1000).toISOString();
    getBcbaPanel.mockResolvedValue([
      { appointmentId: IDS.appt, clientId: IDS.child, rbtId: IDS.rbt, startAt: started, endAt: new Date(Date.now() + 3.4e6).toISOString(), authorizationIds: [IDS.auth], sessionStatus: 'IN_PROGRESS', canStart: false, isRunning: true, startedAt: started },
    ]);
    mount();
    await waitFor(/Session in progress/);
    expect(host.textContent).toContain('Raymond More');      // child NAME, not id
    expect(host.textContent).toMatch(/Session start time/);
    expect(host.textContent).toMatch(/\d{1,2}:\d{2}/); expect(host.textContent).not.toMatch(/:\d{2}:\d{2}/);    // live H:MM timer (no seconds)
    await waitFor(/ABA Therapy/);                             // resolved authorization label
    assertNoTechnicalIds();
  });

  it('shows THIS WEEK progress only when the company configured a target (spec §K)', async () => {
    getBcbaWeeklyHours.mockResolvedValue({
      configured: true, completedText: '18h 00m', targetText: '30h 00m', remainingText: '12h 00m',
      percent: 60, sessionCount: 6, overtime: false,
    });
    mount();
    await waitFor(/This week/);
    expect(host.textContent).toContain('18h 00m');
    expect(host.textContent).toContain('12h 00m remaining');
  });

  it('renders the clinical board below (caseload, attention) once loaded', async () => {
    mount();
    await waitFor(/My Caseload/);
    expect(host.textContent).toContain('My Caseload');
    expect(host.textContent).toContain('Attention');
    assertNoTechnicalIds();
  });
});

describe('BcbaDashboardPage — multi-date appointment (09/12/2026 → 09/30/2026) on 09/13/2026', () => {
  const RANGE = { appointmentId: IDS.appt, clientId: IDS.child, childName: 'Raymond K', timeSet: false,
    startAt: '2026-09-12T00:00:00.000Z', endAt: '2026-10-01T00:00:00.000Z', authorizationIds: [], canStart: true, isRunning: false };
  afterEach(() => { vi.useRealTimers(); });

  it('Start Session represents the 09/13 occurrence, never 09/12 or the whole range', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T15:00:00Z'));
    getBcbaPanel.mockResolvedValue([{ ...RANGE, sessionStatus: 'SCHEDULED', startStatus: 'AVAILABLE', startBusinessDate: '2026-09-13' }]);
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
    getBcbaPanel.mockResolvedValue([{ ...RANGE, sessionStatus: 'STOPPED', canResume: true, sessionBusinessDate: '2026-09-12', startBusinessDate: '2026-09-12', startStatus: 'EXPIRED', expired: true, startableNow: false }]);
    mount();
    await waitFor(/Expired — start window closed 09\/13\/2026 12:00 AM/);
    expect([...host.querySelectorAll('button')].some((b) => /^Start Session$/.test(b.textContent.trim()) && b.getAttribute('aria-label'))).toBe(false);
    expect(host.textContent).not.toMatch(/Start by 09\/13\/2026 11:59 PM/);
    const start = [...host.querySelectorAll('button')].find((b) => /^Start session$/.test(b.textContent.trim()));
    expect(start.disabled).toBe(true);
    expect([...host.querySelectorAll('button')].some((b) => /Finish session/.test(b.textContent))).toBe(true);
  });
});
