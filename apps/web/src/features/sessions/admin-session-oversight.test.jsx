import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Session Insights (Phase 8): child table → child detail (BCBA treatment plan
 * with goals/programs/targets, RBT What/How/Child-response documentation, and
 * separate BCBA/RBT session tables). BCBA and RBT stay independent (their own
 * scheduled + worked time, never merged). Friendly status labels; no raw ids.
 */
const getSessionInsights = vi.fn();
const listSessions = vi.fn();
const listPlans = vi.fn();
const getPlan = vi.fn();
const listClients = vi.fn(async () => ({ items: [{ id: 'c-1', firstName: 'John', lastName: 'Smith' }, { id: 'c-2', firstName: 'Amy', lastName: 'Ray' }] }));
const listStaff = vi.fn(async () => ({ items: [{ id: 'st-1', firstName: 'Sarah', lastName: 'Wilson' }, { id: 'st-2', firstName: 'Mike', lastName: 'Jones' }] }));
vi.mock('@/api/client', () => ({
  getSessionInsights: (...a) => getSessionInsights(...a),
  listClients: (...a) => listClients(...a),
  listStaff: (...a) => listStaff(...a),
  listSessions: (...a) => listSessions(...a),
  listPlans: (...a) => listPlans(...a),
  getPlan: (...a) => getPlan(...a),
}));

vi.mock('@/auth/store', () => ({ useOrgTimezone: () => 'UTC' }));

let container; let root; let AdminSessionOversightPage;

const CHILD_ROWS = [
  { clientId: 'c-1', childName: 'John Smith', bcbaNames: ['Sarah Wilson'], rbtNames: ['Mike Jones'], sessionCount: 2, workedMinutes: 240, lastSessionAt: '2026-09-07T12:45:00Z' },
  { clientId: 'c-2', childName: 'Amy Ray', bcbaNames: [], rbtNames: ['Mike Jones'], sessionCount: 1, workedMinutes: 30, lastSessionAt: '2026-09-05T12:45:00Z' },
];
const insightsFor = (children = CHILD_ROWS) => ({
  timeZone: 'UTC',
  range: { from: '2026-08-16', to: '2026-09-14' },
  totals: { sessions: 3, completed: 2, inProgress: 1, workedMinutes: 270, bcbaSessions: 1, rbtSessions: 2 },
  statusCounts: { FROZEN: 2, IN_PROGRESS: 1 },
  trend: { unit: 'day', points: [{ key: '2026-09-05', sessions: 1, workedMinutes: 30 }, { key: '2026-09-06', sessions: 0, workedMinutes: 0 }, { key: '2026-09-07', sessions: 2, workedMinutes: 240 }] },
  clinicians: [
    { staffProfileId: 'st-2', name: 'Mike Jones', role: 'RBT', sessions: 2, completed: 1, inProgress: 1, workedMinutes: 180 },
    { staffProfileId: 'st-1', name: 'Sarah Wilson', role: 'BCBA', sessions: 1, completed: 1, inProgress: 0, workedMinutes: 90 },
  ],
  recent: [
    { id: 's-rbt', clientId: 'c-1', childName: 'John Smith', clinicianName: 'Mike Jones', role: 'RBT', startedAt: '2026-09-07T10:15:00Z', clockIn: '2026-09-07T10:15:00Z', clockOut: '2026-09-07T12:45:00Z', workedMinutes: 150, status: 'FROZEN', source: 'APPOINTMENT' },
    { id: 's-live', clientId: 'c-2', childName: 'Amy Ray', clinicianName: 'Mike Jones', role: 'RBT', startedAt: '2026-09-05T12:15:00Z', clockIn: '2026-09-05T12:15:00Z', clockOut: null, workedMinutes: null, status: 'IN_PROGRESS', source: 'APPOINTMENT' },
  ],
  children,
});
const SESSION_ROWS = [
  { id: 's-bcba', role: 'BCBA', clientId: 'c-1', appointmentId: 'ap-b', status: 'FROZEN', clinicianName: 'Sarah Wilson', startedAt: '2026-09-07T10:00:00Z', endedAt: '2026-09-07T11:30:00Z', actualStart: '2026-09-07T10:02:00Z', actualEnd: '2026-09-07T11:30:00Z', scheduledStart: '2026-09-07T10:00:00Z', scheduledEnd: '2026-09-07T11:30:00Z', scheduledTimeSet: true, workedMinutes: 90, documentation: { what: null, how: null, childResponse: null } },
  { id: 's-rbt', role: 'RBT', clientId: 'c-1', appointmentId: 'ap-r', status: 'FROZEN', clinicianName: 'Mike Jones', startedAt: '2026-09-07T10:15:00Z', endedAt: '2026-09-07T12:45:00Z', actualStart: '2026-09-07T10:15:00Z', actualEnd: '2026-09-07T12:45:00Z', scheduledStart: '2026-09-07T10:15:00Z', scheduledEnd: '2026-09-07T12:45:00Z', scheduledTimeSet: true, workedMinutes: 150, documentation: { what: 'Practiced requesting', how: 'Prompting + reinforcement', childResponse: 'Independent requests' } },
];
const PLAN_TREE = {
  plan: { id: 'p-1', title: 'Functional Communication', status: 'ACTIVE', updatedAt: '2026-09-01T00:00:00Z', responsibleBcbaName: 'Sarah Wilson' },
  goals: [{ id: 'g-1', title: 'Requesting', programs: [{ id: 'pr-1', title: 'Manding', targets: [{ id: 't-1', title: 'Request preferred item' }] }] }],
};

beforeEach(async () => {
  ({ AdminSessionOversightPage } = await import('./AdminSessionOversightPage.jsx'));
  getSessionInsights.mockReset(); getSessionInsights.mockResolvedValue(insightsFor());
  listSessions.mockReset(); listSessions.mockResolvedValue({ items: SESSION_ROWS });
  listPlans.mockReset(); listPlans.mockResolvedValue({ items: [{ id: 'p-1', title: 'Functional Communication', status: 'ACTIVE', updatedAt: '2026-09-01T00:00:00Z' }] });
  getPlan.mockReset(); getPlan.mockResolvedValue(PLAN_TREE);
  container = document.createElement('div'); document.body.appendChild(container);
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = undefined; });

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => { root.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/sessions/oversight']}><Routes><Route path="/sessions/oversight" element={<AdminSessionOversightPage />} /><Route path="/sessions/:sessionId" element={<div>session detail route</div>} /></Routes></MemoryRouter></QueryClientProvider>); await Promise.resolve(); });
  for (let i = 0; i < 25; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const flush = async (n = 25) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const list = (label) => container.querySelector(`ul[aria-label="${label}"]`);
const clickRowWith = async (re) => {
  const row = [...list('Children').querySelectorAll('li')].find((tr) => re.test(tr.textContent));
  await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  for (let i = 0; i < 25; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

describe('AdminSessionOversightPage (Session Insights)', () => {
  it('renders the Session Insights header and a searchable child list — no UUIDs', async () => {
    await mount();
    const text = container.textContent;
    expect(text).toContain('Session Insights');
    expect(text).toContain('John Smith');
    expect(text).toContain('Sarah Wilson'); // BCBA
    expect(text).toContain('Mike Jones');    // RBT
    expect(text).toMatch(/4h 00m/);          // 240 worked → Xh YYm
    expect(container.querySelector('input[aria-label="Search child"]')).toBeTruthy();
    expect(text).not.toMatch(/c-1|[0-9a-f]{8}-[0-9a-f]{4}/i); // no ids
  });

  it('opens child detail: treatment plan tree, RBT documentation, separate BCBA/RBT times (90 vs 150)', async () => {
    await mount();
    await clickRowWith(/John Smith/);
    const text = container.textContent;
    // Treatment plan section with goals/programs/targets + BCBA name
    expect(text).toContain('Functional Communication');
    expect(text).toContain('Requesting');            // goal
    expect(text).toContain('Manding');               // program
    expect(text).toContain('Request preferred item'); // target
    // RBT documentation
    expect(text).toContain('Practiced requesting');
    expect(text).toContain('Prompting + reinforcement');
    expect(text).toContain('Independent requests');
    // Separate worked times, never merged (Xh YYm display)
    expect(text).toContain('1h 30m');
    expect(text).toContain('2h 30m');
    // Both role tables present
    expect(text).toContain('BCBA Sessions');
    expect(text).toContain('RBT Sessions');
    // Friendly status, never the raw enum
    expect(text).toContain('Approved');
    expect(text).not.toContain('FROZEN');
  });

  it('filters the child list by search term', async () => {
    await mount();
    const input = container.querySelector('input[aria-label="Search child"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Amy');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const text = list('Children').textContent;
    expect(text).toContain('Amy Ray');
    expect(text).not.toContain('John Smith');
  });

  it('shows a friendly empty state for no children', async () => {
    getSessionInsights.mockResolvedValue(insightsFor([]));
    await mount();
    expect(container.textContent).toMatch(/No children available/i);
  });

  it('shows a friendly documentation empty state when the RBT wrote nothing', async () => {
    listSessions.mockResolvedValue({ items: [{ ...SESSION_ROWS[0] }] }); // BCBA only, no docs
    await mount();
    await clickRowWith(/John Smith/);
    expect(container.textContent).toMatch(/No session documentation recorded yet/i);
  });

  it('shows a no-plan message when the child has no active treatment plan', async () => {
    listPlans.mockResolvedValue({ items: [] });
    await mount();
    await clickRowWith(/John Smith/);
    expect(container.textContent).toMatch(/No active treatment plan found/i);
  });

  it('summary metrics, status breakdown and clinician table come from the server aggregation — no estimates', async () => {
    await mount();
    expect(getSessionInsights).toHaveBeenCalledTimes(1);
    expect(getSessionInsights).toHaveBeenCalledWith({ from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    const metrics = [...container.querySelectorAll('.rx-cl__stat')].map((m) => [m.querySelector('.rx-cl__stat-label').textContent, m.querySelector('.rx-cl__stat-value').textContent, m.querySelector('.rx-cl__stat-hint').textContent]);
    expect(metrics).toEqual([
      ['Total sessions', '3', '1 BCBA · 2 RBT'], ['Completed', '2', '67% of sessions'], ['In progress', '1', 'Currently clocked in'], ['Worked hours', '4.5 h', '1h 30m per session'],
    ]);
    const status = container.querySelector('.rx-si__status').textContent;
    expect(status).toMatch(/Approved\s*2/);
    expect(status).toMatch(/In progress\s*1/);
    const clin = [...list('Clinicians').querySelectorAll('li')].map((li) => [li.querySelector('.rx-st__name').textContent, ...[...li.querySelectorAll('.rx-st__cell')].map((c) => c.textContent)]);
    expect(clin).toEqual([
      ['Mike Jones', 'RBT', '2', '1', '1', '3h 00m'],
      ['Sarah Wilson', 'BCBA', '1', '1', '0', '1h 30m'],
    ]);
    // Trend chart is fed by the server buckets (zero-days included), not an empty placeholder.
    expect(container.querySelector('figure, svg')).toBeTruthy();
  });

  it('recent sessions map authoritative times and link to the canonical /sessions/:id detail', async () => {
    await mount();
    const rows = [...list('Recent sessions').querySelectorAll('li')];
    const t = (row, sel) => row.querySelector(sel).textContent;
    expect(t(rows[0], '.rx-ss__child')).toBe('John Smith');
    expect(t(rows[0], '.rx-ss__clinician')).toBe('RBTMike Jones');
    expect(t(rows[0], '.rx-ss__date')).toBe('09/07/2026');
    expect(t(rows[0], '.rx-ss__times')).toBe('Clock-in10:15 AMClock-out12:45 PM');
    expect(t(rows[0], '.rx-ss__worked')).toBe('Worked2h 30m');
    expect(t(rows[0], '.rx-badge')).toBe('Approved');
    expect(t(rows[1], '.rx-ss__times')).toBe('Clock-in12:15 PMClock-outIn progress');
    expect(t(rows[1], '.rx-ss__worked')).toBe('Worked—');
    expect(t(rows[1], '.rx-badge')).toBe('In progress');
    const link = rows[0].querySelector('a');
    expect(link.getAttribute('href')).toBe('/sessions/s-rbt');
    await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); });
    await flush(3);
    expect(container.textContent).toContain('session detail route');
  });

  it('empty period: zero metrics and calm empty messages, never placeholder numbers', async () => {
    getSessionInsights.mockResolvedValue({ timeZone: 'UTC', range: { from: '2026-08-16', to: '2026-09-14' }, totals: { sessions: 0, completed: 0, inProgress: 0, workedMinutes: 0, bcbaSessions: 0, rbtSessions: 0 }, statusCounts: {}, trend: { unit: 'day', points: [] }, clinicians: [], recent: [], children: [] });
    await mount();
    const values = [...container.querySelectorAll('.rx-cl__stat-value')].map((d) => d.textContent);
    expect(values).toEqual(['0', '0', '0', '0 h']);
    expect(container.textContent).toMatch(/No clinician activity in this period/);
    expect(container.textContent).toMatch(/No sessions in this period/);
  });

  it('filters are sent to the server (range preset, client, clinician, status)', async () => {
    await mount();
    const range = async (label) => {
      const btn = [...container.querySelectorAll('[role="radiogroup"][aria-label="Date range"] button')].find((b) => b.textContent === label);
      await act(async () => { btn.click(); });
      await flush(5);
    };
    const pick = async (filterIndex, label) => {
      const trigger = container.querySelectorAll('.rx-si__select .rx-select__trigger')[filterIndex];
      await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush(2);
      const opt = [...document.querySelectorAll('.rx-select__opt')].find((o) => o.textContent.trim() === label);
      await act(async () => { opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await flush(5);
    };
    await range('7 days');
    const last = getSessionInsights.mock.calls.at(-1)[0];
    expect(Object.keys(last)).toEqual(['from', 'to']);
    await range('All time');
    expect(getSessionInsights).toHaveBeenLastCalledWith({});
    await pick(0, 'Amy Ray');
    expect(getSessionInsights).toHaveBeenLastCalledWith({ clientId: 'c-2' });
    await pick(1, 'Mike Jones');
    expect(getSessionInsights).toHaveBeenLastCalledWith({ clientId: 'c-2', staffProfileId: 'st-2' });
    await pick(2, 'In progress');
    expect(getSessionInsights).toHaveBeenLastCalledWith({ clientId: 'c-2', staffProfileId: 'st-2', status: 'IN_PROGRESS' });
  });

  it('shows an error state with retry when insights fail', async () => {
    getSessionInsights.mockRejectedValueOnce(new Error('boom'));
    await mount();
    expect(container.textContent).toMatch(/couldn’t load Session Insights/);
    const retry = [...container.querySelectorAll('button')].find((b) => /^retry$/i.test(b.textContent.trim()));
    await act(async () => { retry.click(); });
    await flush();
    expect(container.textContent).toContain('Total sessions');
    expect(getSessionInsights).toHaveBeenCalledTimes(2);
  });

  it('rangeFor computes org-calendar windows', async () => {
    const { rangeFor } = await import('./AdminSessionOversightPage.jsx');
    const now = new Date('2026-09-14T02:00:00Z'); // still Sep 13 in New York
    expect(rangeFor('7', 'America/New_York', now)).toEqual({ from: '2026-09-07', to: '2026-09-13' });
    expect(rangeFor('30', 'UTC', now)).toEqual({ from: '2026-08-16', to: '2026-09-14' });
    expect(rangeFor('all', 'UTC', now)).toEqual({});
  });
});
