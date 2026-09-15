import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * BcbaSessionPanelPage — act()-clean behavior tests (spec Part 21) plus the
 * spec's user-friendly-data guarantees: the panel renders only the SERVER's
 * assigned children (Part 3), a start 409 surfaces an actionable message
 * (Part 20), the ACTIVE session appears at the top with a human window/timer
 * (spec §C), names replace ids (spec §A/§B), and the weekly-progress block only
 * appears when the company configured a target (spec §K). A DOM-wide assertion
 * proves no UUID / Mongo id / svc: / raw ISO timestamp is ever rendered.
 */

const IDS = {
  appt: '01a051e4-c8fd-71a1-b09e-3e86422eb6c2',
  child: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  rbt: 'b1e2c3d4-e5f6-4789-abcd-0123456789ab',
  auth: 'svc:9f8e7d6c5b4a',
};

const getBcbaPanel = vi.fn();
const startBcbaSession = vi.fn();
const stopBcbaSession = vi.fn();
const completeBcbaSession = vi.fn();
const listClients = vi.fn(() => Promise.resolve({ items: [{ id: IDS.child, firstName: 'Raymond', lastName: 'More' }] }));
const listStaff = vi.fn(() => Promise.resolve({ items: [{ id: IDS.rbt, firstName: 'Nia', lastName: 'Patel' }] }));
const getBcbaWeeklyHours = vi.fn(() => Promise.resolve({ configured: false }));
const getBcbaChildDetail = vi.fn(() => Promise.resolve({
  child: { firstName: 'Raymond', lastName: 'More', age: 8, status: 'ACTIVE' },
  appointment: {
    startAt: new Date().toISOString(), endAt: new Date().toISOString(), rbtId: IDS.rbt,
    authorizationIds: [IDS.auth],
    authorizations: [{ id: IDS.auth, label: 'ABA Therapy — ABC Insurance — AUTH-12345', serviceCode: '97153' }],
  },
  activePlan: null, session: { status: 'IN_PROGRESS' },
}));

vi.mock('@/api/client', () => ({
  getBcbaPanel: (...a) => getBcbaPanel(...a),
  startBcbaSession: (...a) => startBcbaSession(...a),
  stopBcbaSession: (...a) => stopBcbaSession(...a),
  completeBcbaSession: (...a) => completeBcbaSession(...a),
  listClients: (...a) => listClients(...a),
  listStaff: (...a) => listStaff(...a),
  getBcbaWeeklyHours: (...a) => getBcbaWeeklyHours(...a),
  getBcbaChildDetail: (...a) => getBcbaChildDetail(...a),
  saveBcbaSessionDocumentation: vi.fn(() => Promise.resolve({})),
}));

let host; let root; let consoleErrorSpy; let BcbaSessionPanelPage;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

beforeEach(async () => {
  ({ BcbaSessionPanelPage } = await import('./BcbaSessionPanelPage.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  getBcbaPanel.mockReset(); startBcbaSession.mockReset();
  getBcbaWeeklyHours.mockReset(); getBcbaWeeklyHours.mockResolvedValue({ configured: false });
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
    <QueryClientProvider client={qc}><MemoryRouter><BcbaSessionPanelPage /></MemoryRouter></QueryClientProvider>,
  ));
};
const waitFor = async (re) => { for (let i = 0; i < 80; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found in: ${host.textContent.slice(0, 300)}`); };

/** No raw database identifier or ISO timestamp anywhere in the rendered DOM (spec §A). */
function assertNoTechnicalIds() {
  const text = host.textContent;
  for (const [k, v] of Object.entries(IDS)) {
    expect(text, `leaked ${k} (${v})`).not.toContain(v);
  }
  expect(text, 'leaked a svc: transport id').not.toMatch(/svc:/);
  expect(text, 'leaked a UUID').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(text, 'leaked a raw ISO timestamp').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
}

describe('BcbaSessionPanelPage', () => {
  it('renders exactly the assigned appointments the server returned, with names not ids', async () => {
    getBcbaPanel.mockResolvedValue([
      { appointmentId: IDS.appt, clientId: IDS.child, rbtId: IDS.rbt, startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3.6e6).toISOString(), authorizationIds: [IDS.auth], sessionStatus: 'SCHEDULED', canStart: true, isRunning: false },
    ]);
    mount();
    await waitFor(/Start session/);
    expect(host.querySelectorAll('.rx-card').length).toBeGreaterThanOrEqual(1);
    expect(getBcbaPanel).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Raymond More'); // child name
    expect(host.textContent).toContain('Nia Patel');     // RBT name, not the id
    assertNoTechnicalIds();
  });

  it("yesterday's appointment is shown EXPIRED with Start disabled; today's stays startable", async () => {
    // 25h ago: its 24-hour start window closed an hour ago (server says EXPIRED).
    const y = new Date(Date.now() - 25 * 3.6e6);
    getBcbaPanel.mockResolvedValue([
      { appointmentId: IDS.appt, clientId: IDS.child, rbtId: IDS.rbt, startAt: y.toISOString(), endAt: new Date(y.getTime() + 3.6e6).toISOString(), authorizationIds: [], sessionStatus: 'SCHEDULED', canStart: true, isRunning: false, startStatus: 'EXPIRED', expired: true, startableNow: false },
      { appointmentId: 'appt-today', clientId: IDS.child, rbtId: IDS.rbt, startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3.6e6).toISOString(), authorizationIds: [], sessionStatus: 'SCHEDULED', canStart: true, isRunning: false, startStatus: 'AVAILABLE', expired: false, startableNow: true },
    ]);
    mount();
    await waitFor(/Expired — start window closed/);
    const starts = [...host.querySelectorAll('button')].filter((b) => /^Start session$/.test(b.textContent.trim()));
    expect(starts.map((b) => b.disabled).sort()).toEqual([false, true]);
    expect([...host.querySelectorAll('.rx-badge')].some((b) => b.textContent.trim() === 'Expired')).toBe(true);
    expect(host.textContent).toMatch(/Expired — start window closed \d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M/);
    expect(host.textContent).toContain('Expired appointments');
    const disabled = starts.find((b) => b.disabled);
    await act(async () => { disabled.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(startBcbaSession).not.toHaveBeenCalled();
    assertNoTechnicalIds();
  });

  it('shows an empty state when the BCBA has no assigned appointments', async () => {
    getBcbaPanel.mockResolvedValue([]);
    mount();
    await waitFor(/No appointments assigned to you/);
    expect(host.textContent).toContain('No appointments assigned to you');
  });

  it('surfaces a start 409 as an actionable message (no infinite spinner, Part 20)', async () => {
    getBcbaPanel.mockResolvedValue([
      { appointmentId: IDS.appt, clientId: IDS.child, rbtId: IDS.rbt, startAt: new Date().toISOString(), authorizationIds: [], sessionStatus: 'SCHEDULED', canStart: true, isRunning: false },
    ]);
    startBcbaSession.mockRejectedValue({ response: { data: { error: { message: 'This session has already been completed.' } } } });
    mount();
    await waitFor(/Start session/);
    const btn = [...host.querySelectorAll('button')].find((b) => /Start session/.test(b.textContent));
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(/already been completed/);
    expect(host.textContent).toContain('This session has already been completed.');
  });

  it('shows the active session as a prominent hero at the top, with human data (spec §C)', async () => {
    const started = new Date(Date.now() - 26 * 60 * 1000).toISOString(); // 26 min ago
    getBcbaPanel.mockResolvedValue([
      { appointmentId: IDS.appt, clientId: IDS.child, rbtId: IDS.rbt, startAt: started, endAt: new Date(Date.now() + 3.4e6).toISOString(), authorizationIds: [IDS.auth], sessionStatus: 'IN_PROGRESS', canStart: false, isRunning: true, startedAt: started },
    ]);
    mount();
    await waitFor(/Session in progress/);
    expect(host.textContent).toContain('Raymond More');
    expect(host.textContent).toMatch(/Session start time/);
    expect(host.textContent).toMatch(/\b\d{1,2}:\d{2}\b/); // running H:MM timer (no seconds, Phase 4 §13)
    expect(host.textContent).not.toMatch(/\d{1,2}:\d{2}:\d{2}/); // never seconds
    await waitFor(/ABA Therapy/);                            // resolved authorization label
    expect([...host.querySelectorAll('button')].some((b) => /Stop session/.test(b.textContent))).toBe(true);
    assertNoTechnicalIds();
  });

  it('shows weekly progress only when the company configured a target (spec §K)', async () => {
    getBcbaPanel.mockResolvedValue([]);
    getBcbaWeeklyHours.mockResolvedValue({
      configured: true, completedText: '18h 00m', targetText: '30h 00m', remainingText: '12h 00m',
      percent: 60, sessionCount: 6, overtime: false,
    });
    mount();
    await waitFor(/This week/);
    expect(host.textContent).toContain('18h 00m');
    expect(host.textContent).toContain('30h 00m');
    expect(host.textContent).toContain('12h 00m remaining');
  });
});

describe('BcbaSessionPanelPage — assigned RBT name', () => {
  it('names the child’s assigned RBT when the appointment itself names only the BCBA, and "None" when no RBT is assigned', async () => {
    const soon = new Date(Date.now() - 60000).toISOString();
    const later = new Date(Date.now() + 3.6e6).toISOString();
    getBcbaPanel.mockResolvedValue([
      { appointmentId: 'appt-a', clientId: IDS.child, rbtId: null, assignedRbtName: 'Ben Carter', childName: 'Raymond More', startAt: soon, endAt: later, authorizationIds: [], sessionStatus: 'SCHEDULED', canStart: true, isRunning: false, startStatus: 'AVAILABLE' },
      { appointmentId: 'appt-b', clientId: 'client-2', rbtId: null, assignedRbtName: null, childName: 'Mia Khan', startAt: soon, endAt: later, authorizationIds: [], sessionStatus: 'SCHEDULED', canStart: true, isRunning: false, startStatus: 'AVAILABLE' },
    ]);
    mount();
    await waitFor(/Mia Khan/);
    const rows = [...host.querySelectorAll('.rx-sq__row')];
    expect(rows.find((r) => /Raymond More/.test(r.textContent)).textContent).toContain('RBT: Ben Carter');
    expect(rows.find((r) => /Mia Khan/.test(r.textContent)).textContent).toContain('RBT: None');
  });
});
