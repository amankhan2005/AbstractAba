import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Company Admin Dashboard — presentation of GET /v1/dashboards/company.
 * Every value on screen must come from the API payload: charts are drawn from
 * its counts, lists from its rows, and empty sections say so instead of
 * showing invented data.
 */
const getCompanyDashboard = vi.fn();
const getAppointmentNote = vi.fn();
vi.mock('@/api/client', () => ({
  getCompanyDashboard: (...a) => getCompanyDashboard(...a),
  getAppointmentNote: (...a) => getAppointmentNote(...a),
  listAppointmentNotesOverview: vi.fn(),
}));
vi.mock('@/auth/store', () => ({
  useOrgTimezone: () => 'America/New_York',
  useAuthStore: (sel) => sel({ principal: { roles: ['org_admin'] } }),
}));

const here = dirname(fileURLToPath(import.meta.url));

const DATA = {
  scope: 'company', generatedAt: '2026-09-14T14:00:00.000Z', timeZone: 'America/New_York', businessDate: '2026-09-14',
  clients: { total: 20, active: 15, inactive: 5, byStatus: { ACTIVE: 15, REFERRED: 3, ON_HOLD: 2 }, byAccount: { ACTIVE: 15, HOLD: 3, DISCHARGED: 2 } },
  staff: { bcba: 3, rbt: 9, activeStaff: 13, total: 16, active: 13, inactive: 3, byStatus: { ACTIVE: 13, INACTIVE: 3 } },
  sessionsByRole: { period: { from: '2026-09-01', to: '2026-09-14' }, BCBA: { sessions: 21, completed: 18, workedMinutes: 1890 }, RBT: { sessions: 64, completed: 60, workedMinutes: 5775 } },
  attention: {
    total: 2,
    items: [
      { clientId: 'c-eve', clientName: 'eve e', status: 'ON_HOLD', severity: 'CRITICAL', missing: [{ code: 'INTAKE_INCOMPLETE', label: 'Intake is missing documents.' }] },
      { clientId: 'c-ray', clientName: 'Raymond K', status: 'REFERRED', severity: 'WARNING', missing: [{ code: 'PARENT_DETAILS_REQUIRED', label: 'Parent/guardian details incomplete' }, { code: 'INTAKE_INCOMPLETE', label: 'Intake is not yet complete.' }] },
    ],
  },
  expiringAuthorizations: {
    total: 1,
    items: [{ authorizationId: 'a-1', clientId: 'c-ray', clientName: 'Raymond K', serviceType: 'ABA', authorizationNumber: 'AUTH-777', billingCode: '97153', endDate: '2026-09-20', daysLeft: 6, status: 'APPROVED' }],
  },
  today: {
    total: 3,
    byRole: { BCBA: 1, RBT: 2 },
    items: [
      { key: 'ap-1:RBT', appointmentId: 'ap-1', sessionId: null, clientName: 'Ada B', clinicianName: 'Omar Diaz', role: 'RBT', status: 'SCHEDULED', source: null, timeKind: 'ALL_DAY', startAt: null, endAt: null, workedMinutes: null },
      { key: 'ap-2:BCBA', appointmentId: 'ap-2', sessionId: 's-2', clientName: 'Raymond K', clinicianName: 'test1 J', role: 'BCBA', status: 'COMPLETED', source: null, timeKind: 'ACTUAL', startAt: '2026-09-14T14:00:00.000Z', endAt: '2026-09-14T15:30:00.000Z', workedMinutes: 90 },
      { key: 'ap-3:RBT', appointmentId: 'ap-3', sessionId: 's-3', clientName: 'Cam N', clinicianName: 'Nia Patel', role: 'RBT', status: 'COMPLETED', source: 'MANUAL', timeKind: 'ACTUAL', startAt: '2026-09-14T16:15:00.000Z', endAt: '2026-09-14T17:45:00.000Z', workedMinutes: 90 },
    ],
  },
  appointmentNotes: {
    total: 2,
    items: [
      { noteId: 'n-2', appointmentId: 'ap-3', authorFirstName: 'PRIYA', noteClientName: 'Bea Stone', updatedAt: '2026-09-14T15:30:00.000Z' },
      { noteId: 'n-1', appointmentId: 'ap-2', authorFirstName: 'test1', noteClientName: null, updatedAt: '2026-09-14T13:05:00.000Z' },
    ],
  },
  latestSessions: [
    { sessionId: 's-3', clientName: 'Cam N', clinicianName: 'Nia Patel', role: 'RBT', startedAt: '2026-09-14T16:15:00.000Z', endedAt: '2026-09-14T17:45:00.000Z', clockIn: '2026-09-14T16:17:00.000Z', clockOut: '2026-09-14T17:47:00.000Z', workedMinutes: 90, status: 'FROZEN', source: 'MANUAL' },
    { sessionId: 's-2', clientName: 'Raymond K', clinicianName: 'test1 J', role: 'BCBA', startedAt: '2026-09-14T14:00:00.000Z', endedAt: '2026-09-14T15:30:00.000Z', clockIn: '2026-09-14T14:00:00.000Z', clockOut: '2026-09-14T15:30:00.000Z', workedMinutes: 90, status: 'SUBMITTED', source: null },
    { sessionId: 's-1', clientName: 'Ada B', clinicianName: 'Omar Diaz', role: 'RBT', startedAt: '2026-09-12T03:30:00.000Z', endedAt: null, clockIn: '2026-09-12T03:30:00.000Z', clockOut: null, workedMinutes: null, status: 'IN_PROGRESS', source: null },
    { sessionId: 's-0', clientName: 'Dee D', clinicianName: 'Nia Patel', role: 'RBT', startedAt: '2026-09-11T13:00:00.000Z', endedAt: '2026-09-11T14:05:00.000Z', clockIn: '2026-09-11T13:00:00.000Z', clockOut: '2026-09-11T14:05:00.000Z', workedMinutes: 65, status: 'FROZEN', source: null },
  ],
};

const EMPTY = {
  scope: 'company', generatedAt: '2026-09-14T14:00:00.000Z', timeZone: 'America/New_York', businessDate: '2026-09-14',
  clients: { total: 0, active: 0, inactive: 0, byStatus: {}, byAccount: { ACTIVE: 0, HOLD: 0, DISCHARGED: 0 } },
  staff: { bcba: 0, rbt: 0, activeStaff: 0, total: 0, active: 0, inactive: 0, byStatus: {} },
  sessionsByRole: { period: { from: '2026-09-01', to: '2026-09-14' }, BCBA: { sessions: 0, completed: 0, workedMinutes: 0 }, RBT: { sessions: 0, completed: 0, workedMinutes: 0 } },
  attention: { total: 0, items: [] },
  expiringAuthorizations: { total: 0, items: [] },
  today: { total: 0, byRole: { BCBA: 0, RBT: 0 }, items: [] },
  appointmentNotes: { total: 0, items: [] },
  latestSessions: [],
};

let host; let root; let mod;
beforeEach(async () => {
  mod = await import('./CompanyDashboardPage.jsx');
  getCompanyDashboard.mockReset(); getAppointmentNote.mockReset();
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><MemoryRouter><mod.CompanyDashboardPage /></MemoryRouter></QueryClientProvider>));
};
const settle = async () => { for (let i = 0; i < 30; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const panel = (title) => [...host.querySelectorAll('.rx-db__panel')].find((c) => c.querySelector('.rx-card__title')?.textContent === title);
const stats = () => [...host.querySelectorAll('.rx-cl__stat')].map((k) => ({
  label: k.querySelector('.rx-cl__stat-label').textContent, value: k.querySelector('.rx-cl__stat-value').textContent,
  hint: k.querySelector('.rx-cl__stat-hint').textContent, href: k.getAttribute('href'),
}));

describe('Company Admin Dashboard', () => {
  it('uses the Client / Staff page header ("Dashboard"), ONE dashboard API call, sections in order', async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    mount(); await settle();
    expect(host.querySelector('.rx-st__head h1.rx-st__title').textContent).toBe('Dashboard');
    expect(host.querySelector('.rx-st__head .rx-st__subtitle').textContent).toBe('Clients, staff, sessions and today’s priorities across your organization.');
    expect(host.querySelector('.rx-db__date').textContent).toBe('Monday, 09/14/2026');
    expect(getCompanyDashboard).toHaveBeenCalledTimes(1);
    expect([...host.querySelectorAll('h2')].map((t) => t.textContent)).toEqual([
      'Client overview', 'Staff overview', 'BCBA and RBT sessions', 'Today’s sessions',
      'Clients needing attention', 'Expiring authorizations', 'BCBA Appointment Notes', 'Latest sessions',
    ]);
    expect(host.textContent).not.toMatch(/Organization Overview|Reporting period|Payroll snapshot|Billing snapshot/);
  });

  it('summary cards are the Client page cards with server totals and links', async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    mount(); await settle();
    expect(host.querySelector('section.rx-cl__summary')).toBeTruthy();
    expect(stats()).toEqual([
      { label: 'Total clients', value: '20', hint: '15 active · 5 inactive', href: '/clients' },
      { label: 'Total staff', value: '16', hint: '13 active · 3 inactive', href: '/staff' },
      { label: 'Today’s sessions', value: '3', hint: '1 BCBA · 2 RBT', href: '#dash-today' },
      { label: 'Needs attention', value: '2', hint: '1 authorization expiring soon', href: '#dash-attention' },
    ]);
  });

  it('client and staff overview charts are drawn from the API counts; chart totals equal the displayed totals', async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    mount(); await settle();
    const clientsChart = panel('Client overview').querySelector('[role="img"]');
    expect(clientsChart.getAttribute('aria-label')).toBe('Clients by account status: Active 15 of 20 (75%), Hold 3 of 20 (15%), Discharged 2 of 20 (10%)');
    expect([...panel('Client overview').querySelectorAll('.rx-legend__item')].map((li) => li.textContent)).toEqual(['Active15 · 75%', 'Hold3 · 15%', 'Discharged2 · 10%']);

    const staffChart = panel('Staff overview').querySelector('[role="img"]');
    expect(staffChart.getAttribute('aria-label')).toBe('Staff by status: Active 13 of 16 (81%), Inactive 3 of 16 (19%)');
    expect(Object.fromEntries([...panel('Staff overview').querySelectorAll('.rx-db__breakdown-row')].map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent])))
      .toEqual({ 'Active BCBAs': '3', 'Active RBTs': '9' });
  });

  it('BCBA and RBT sessions stay separate: month-to-date sessions, completed, worked time and today', async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    mount(); await settle();
    const card = panel('BCBA and RBT sessions');
    expect(card.querySelector('.rx-card__hint').textContent).toBe('Month to date · 09/01/2026 – 09/14/2026');
    const role = (r) => Object.fromEntries([...card.querySelectorAll(`.rx-db__role--${r} dl > div`)].map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]));
    expect(role('bcba')).toEqual({ Sessions: '21', Completed: '18', Worked: '31h 30m', Today: '1' });
    expect(role('rbt')).toEqual({ Sessions: '64', Completed: '60', Worked: '96h 15m', Today: '2' });
  });

  it('a different payload renders different numbers — nothing is hardcoded', async () => {
    getCompanyDashboard.mockResolvedValue({ ...DATA, clients: { total: 7, active: 1, inactive: 6, byStatus: {}, byAccount: { ACTIVE: 1, HOLD: 6, DISCHARGED: 0 } }, staff: { bcba: 2, rbt: 0, activeStaff: 2, total: 2, active: 2, inactive: 0, byStatus: { ACTIVE: 2 } } });
    mount(); await settle();
    expect(panel('Client overview').querySelector('[role="img"]').getAttribute('aria-label')).toBe('Clients by account status: Active 1 of 7 (14%), Hold 6 of 7 (86%)');
    expect(panel('Staff overview').querySelector('[role="img"]').getAttribute('aria-label')).toBe('Staff by status: Active 2 of 2 (100%)');
    expect(stats().map((k) => k.value)).toEqual(['7', '2', '3', '2']);
  });

  it("today's sessions: Staff-page list table with org-timezone time, client, role, clinician, status and View only when a session exists", async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    mount(); await settle();
    const rows = [...panel('Today’s sessions').querySelectorAll('li.rx-st__row')];
    expect(rows.map((r) => [r.querySelector('.rx-db__time').textContent, r.querySelector('.rx-st__name').textContent, ...[...r.querySelectorAll('.rx-st__cell:not(.rx-db__time)')].map((c) => c.textContent)])).toEqual([
      ['All day', 'Ada B', 'RBTOmar Diaz', 'Scheduled'],
      ['10:00 AM – 11:30 AM', 'Raymond K', 'BCBATest1 J', 'Completed'],
      ['12:15 PM – 1:45 PM', 'Cam N', 'RBTNia Patel', 'CompletedManual'],
    ]);
    expect(rows[0].querySelector('a')).toBeNull();
    expect(rows[0].textContent).toContain('Not started');
    expect(rows[1].querySelector('.rx-st__actions a').getAttribute('href')).toBe('/sessions/s-2');
    expect(panel('Today’s sessions').querySelector('.rx-st__listhead').textContent).toBe('TimeClientClinicianStatusActions');
  });

  it('clients needing attention: name, current status, missing items, severity and a View client action', async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    mount(); await settle();
    const items = [...panel('Clients needing attention').querySelectorAll('.rx-db__item')];
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.rx-db__item-title').textContent).toBe('Eve EOn hold');
    expect(items[0].className).toContain('rx-db__item--critical');
    expect([...items[1].querySelectorAll('.rx-db__reasons li')].map((c) => c.textContent)).toEqual(['Parent/guardian details incomplete', 'Intake is not yet complete.']);
    const action = [...items[1].querySelectorAll('a')].find((a) => a.textContent === 'View client');
    expect(action.getAttribute('href')).toBe('/clients/c-ray');
    expect(panel('Clients needing attention').querySelector('.rx-db__panel-head .rx-badge').textContent).toBe('2');
  });

  it('expiring authorizations: client, authorization, status, expiry date (never shifted) and days left', async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    mount(); await settle();
    const item = panel('Expiring authorizations').querySelector('.rx-db__item');
    expect(item.querySelector('.rx-st__name').textContent).toBe('Raymond K');
    expect(item.querySelector('.rx-st__name').getAttribute('href')).toBe('/clients/c-ray');
    expect([...item.querySelectorAll('.rx-db__meta')].map((m) => m.textContent)).toEqual(['ABA · #AUTH-777 · Approved', 'Expires 09/20/2026']);
    expect(item.querySelector('.rx-badge').textContent).toBe('In 6 days');
  });

  it('BCBA appointment notes: "<First> has added notes"; opening shows the persisted read-only note for the business date', async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    getAppointmentNote.mockImplementation(async (id) => (id === 'ap-2'
      ? { appointmentId: 'ap-2', businessDate: '2026-09-14', exists: true, note: 'Worked on requesting.', clientId: null, clientName: null, authorFirstName: 'test1', canEdit: false }
      : { appointmentId: 'ap-3', businessDate: '2026-09-14', exists: true, note: 'Plan with Bea.', clientId: 'x', clientName: 'Bea Stone', authorFirstName: 'PRIYA', canEdit: false }));
    mount(); await settle();
    const buttons = [...panel('BCBA Appointment Notes').querySelectorAll('.rx-db__note')];
    expect(buttons.map((b) => b.querySelector('.rx-db__note-msg').textContent)).toEqual(['Priya has added notes', 'Test1 has added notes']);
    await act(async () => { buttons[1].click(); }); await settle();
    const dialog = document.querySelector('[role="dialog"]');
    const facts = Object.fromEntries([...dialog.querySelectorAll('.rx-apptnote__fact')].map((f) => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]));
    expect(facts).toEqual({ BCBA: 'Test1', Note: 'Worked on requesting.' });
    expect(dialog.textContent).not.toContain('Raymond K');
    expect(dialog.querySelector('textarea')).toBeNull();
    expect(getAppointmentNote).toHaveBeenCalledWith('ap-2');
  });

  it('latest sessions: the Sessions page rows — client, clinician, role, date, clock in/out from the time record, worked time, status, canonical link', async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    mount(); await settle();
    const rows = [...host.querySelectorAll('ul[aria-label="Latest sessions"] li.rx-ss__row')];
    const t = (row, sel) => row.querySelector(sel).textContent;
    expect(rows).toHaveLength(4);
    expect([t(rows[0], '.rx-ss__child'), t(rows[0], '.rx-ss__clinician'), t(rows[0], '.rx-ss__date'), t(rows[0], '.rx-ss__times'), t(rows[0], '.rx-ss__worked'), t(rows[0], '.rx-badge')])
      .toEqual(['Cam N', 'RBTNia Patel', '09/14/2026', 'Clock-in12:17 PMClock-out1:47 PM', 'Worked1h 30m', 'Completed']);
    expect([t(rows[1], '.rx-ss__worked'), t(rows[1], '.rx-badge')]).toEqual(['Worked1h 30m', 'Submitted']);
    expect([t(rows[2], '.rx-ss__date'), t(rows[2], '.rx-ss__times'), t(rows[2], '.rx-ss__worked'), t(rows[2], '.rx-badge')])
      .toEqual(['09/11/2026', 'Clock-in11:30 PMClock-outIn progress', 'Worked—', 'In progress']); // 03:30 UTC 09/12 is 09/11 in New York
    expect([t(rows[3], '.rx-ss__worked'), t(rows[3], '.rx-badge')]).toEqual(['Worked1h 05m', 'Approved']);
    expect(rows[0].querySelector('a').getAttribute('href')).toBe('/sessions/s-3');
    const viewAll = [...host.querySelectorAll('.rx-db__section-head a')].find((a) => a.textContent.includes('View all sessions'));
    expect(viewAll.getAttribute('href')).toBe('/sessions');
  });

  it('empty datasets: accurate empty states and real zeros, no charts and no fabricated rows', async () => {
    getCompanyDashboard.mockResolvedValue(EMPTY);
    mount(); await settle();
    expect(host.querySelectorAll('[role="img"]')).toHaveLength(0);
    expect(stats().map((k) => k.value)).toEqual(['0', '0', '0', '0']);
    expect(panel('Client overview').textContent).toContain('No clients yet');
    expect(panel('Staff overview').textContent).toContain('No staff yet');
    expect(panel('Clients needing attention').textContent).toContain('No clients require attention.');
    expect(panel('Expiring authorizations').textContent).toContain('No authorizations require attention.');
    expect(panel('Today’s sessions').textContent).toContain('No sessions scheduled for today.');
    expect(panel('BCBA Appointment Notes').textContent).toContain('No appointment notes today.');
    expect(host.textContent).toContain('No sessions recorded yet.');
    expect(host.querySelectorAll('.rx-db__item, .rx-st__row, .rx-db__note, .rx-ss__row')).toHaveLength(0);
  });

  it('notes section is hidden when the server omits it (no note permission); the row becomes two equal columns', async () => {
    getCompanyDashboard.mockResolvedValue({ ...DATA, appointmentNotes: null });
    mount(); await settle();
    expect(panel('BCBA Appointment Notes')).toBeUndefined();
    expect(host.querySelector('#dash-attention').parentElement.className).toBe('rx-db__grid rx-db__grid--lists rx-db__grid--2');
  });

  it('shows "Showing N of M" when the server returned a partial list', async () => {
    getCompanyDashboard.mockResolvedValue({ ...DATA, attention: { ...DATA.attention, total: 11 } });
    mount(); await settle();
    expect(panel('Clients needing attention').textContent).toContain('Showing 2 of 11');
  });

  it('loading state: skeletons only — no misleading zero counts', async () => {
    getCompanyDashboard.mockReturnValue(new Promise(() => {}));
    mount(); await settle();
    const skeleton = host.querySelector('[aria-busy="true"]');
    expect(skeleton).toBeTruthy();
    expect(skeleton.querySelectorAll('.rx-skel').length).toBeGreaterThan(5);
    expect(host.textContent.replace('Dashboard', '')).not.toMatch(/\d/);
    expect(host.querySelector('.rx-db__date')).toBeNull();
  });

  it('error state: a message and a working Retry', async () => {
    getCompanyDashboard.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(DATA);
    mount(); await settle();
    expect(host.textContent).toContain('We couldn’t load the dashboard');
    expect(host.querySelectorAll('.rx-cl__stat')).toHaveLength(0);
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    await act(async () => { retry.click(); }); await settle();
    expect(panel('Client overview')).toBeTruthy();
    expect(getCompanyDashboard).toHaveBeenCalledTimes(2);
  });

  it('layout rules: one 80rem container, equal-track rows with one gap; 3 → 2 → 1 columns; list rows keep data labels', async () => {
    getCompanyDashboard.mockResolvedValue(DATA);
    mount(); await settle();
    expect([...panel('Today’s sessions').querySelectorAll('.rx-st__cell')].every((c) => c.hasAttribute('data-label'))).toBe(true);
    const css = readFileSync(resolve(here, '../../../styles/redesign.css'), 'utf8');
    expect(css).toMatch(/\.rx-db \{ max-width: 80rem; margin: 0 auto; width: 100%; display: grid; gap: 18px;/);
    expect(css).toMatch(/\.rx-db__grid \{ display: grid; gap: 18px;/);
    expect(css).toMatch(/\.rx-db__grid--3 \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
    expect(css).toMatch(/@media \(max-width: 1200px\) \{\s*\.rx-db__grid--3 \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    expect(css).toMatch(/@media \(max-width: 900px\) \{\s*\.rx-db__grid--2, \.rx-db__grid--3 \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(css).not.toMatch(/\.rx-od__|\.rx-dash__/);
  });
});

describe('presentation helpers', () => {
  it('todayTimeText follows the server time classification', () => {
    const tz = 'America/New_York';
    expect(mod.todayTimeText({ timeKind: 'ALL_DAY' }, tz)).toBe('All day');
    expect(mod.todayTimeText({ timeKind: 'ACTUAL', startAt: '2026-09-14T14:15:00Z', endAt: null }, tz)).toBe('Started 10:15 AM');
    expect(mod.todayTimeText({ timeKind: 'SCHEDULED', startAt: '2026-09-14T19:00:00Z', endAt: '2026-09-14T20:00:00Z' }, tz)).toBe('3:00 PM – 4:00 PM');
    expect(mod.workedText(90)).toBe('1h 30m');
    expect(mod.workedText(null)).toBeNull();
  });
});
