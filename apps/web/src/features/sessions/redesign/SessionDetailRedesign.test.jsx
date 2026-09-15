import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * SessionDetailRedesign — the spec §3–§7 fix. The page must render REAL session
 * data (child, BCBA/RBT, status, scheduled window, actual start/end, duration,
 * clock in/out, units, authorization label, payroll, note), must NOT show the
 * "Signatures & verification" section, and must never leak a database id or raw
 * ISO timestamp.
 *
 * The root cause it guards against: GET /v1/sessions/:id returns
 * `{ session, dataPoints, child, appointment, payroll }`. The page previously
 * read fields off the wrapper (undefined) and rendered every value blank.
 */

const IDS = {
  session: '01a051e4-c8fd-71a1-b09e-3e86422eb6c2',
  child: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  bcba: 'a1111111-2222-4333-8444-555566667777',
  rbt: 'b1e2c3d4-e5f6-4789-abcd-0123456789ab',
  auth: 'svc:9f8e7d6c5b4a',
};

const getSession = vi.fn();
const noop = vi.fn(() => Promise.resolve({}));
const listClients = vi.fn(() => Promise.resolve({ items: [{ id: IDS.child, firstName: 'Raymond', lastName: 'More' }] }));
const listStaff = vi.fn(() => Promise.resolve({ items: [
  { id: IDS.bcba, firstName: 'Aman', lastName: 'Khan' },
  { id: IDS.rbt, firstName: 'Nia', lastName: 'Patel' },
] }));

vi.mock('@/api/client', () => ({
  getSession: (...a) => getSession(...a),
  clockInSession: noop, clockOutSession: noop, submitSession: noop, freezeSession: noop,
  returnSession: noop, cancelSession: noop, amendSession: noop,
  listClients: (...a) => listClients(...a),
  listStaff: (...a) => listStaff(...a),
}));
// Mutable so a test can render the PRE-BOOTSTRAP state, where `principal` is
// still null. Defaults to a resolved principal so existing cases are unchanged.
const authState = { status: 'authenticated', principal: { permissions: ['sessions.read', 'sessions.review'] } };
const setAuth = (next) => { authState.status = next.status; authState.principal = next.principal; };
// The organization's business timezone (what useOrgTimezone returns). Mutable per test.
const orgTz = { value: null };
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel(authState), useOrgTimezone: () => orgTz.value }));
vi.mock('@/components', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig()), useParams: () => ({ sessionId: '01a051e4-c8fd-71a1-b09e-3e86422eb6c2' }) }));

const START = '2026-09-04T21:51:12.000Z';
const END = '2026-09-04T22:48:31.000Z';
const DETAIL = {
  session: {
    id: IDS.session, clientId: IDS.child, staffProfileId: IDS.bcba, status: 'FROZEN',
    startedAt: START, endedAt: END, clockInAt: START, clockOutAt: END,
    selectedAuthorizationId: IDS.auth, narrative: 'Worked on functional communication and requesting.',
  },
  dataPoints: [],
  child: { firstName: 'Raymond', lastName: 'More', preferredName: null, age: 8 },
  appointment: {
    startAt: '2026-09-04T21:50:00.000Z', endAt: '2026-09-04T22:50:00.000Z',
    bcbaId: IDS.bcba, rbtId: IDS.rbt, units: 4,
    authorizations: [{ id: IDS.auth, label: 'ABA Therapy — ABC Insurance — AUTH-12345', serviceCode: '97153' }],
    selectedAuthorization: { id: IDS.auth, label: 'ABA Therapy — ABC Insurance — AUTH-12345', serviceCode: '97153' },
  },
  payroll: { workedMinutes: 57, hourlyRateSnapshot: 3000, amount: 2850, currency: 'usd' },
  display: { childName: 'Raymond More', bcbaName: 'Aman Khan', rbtName: 'Nia Patel' },
};

let host; let root; let consoleErrorSpy; let SessionDetailRedesign;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

beforeEach(async () => {
  ({ SessionDetailRedesign } = await import('./SessionDetailRedesign.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  getSession.mockReset(); getSession.mockResolvedValue(DETAIL);
  orgTz.value = null;
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
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={['/sessions/s-1']}><SessionDetailRedesign /></MemoryRouter></QueryClientProvider>,
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

describe('SessionDetailRedesign', () => {
  it('renders real session data: child, BCBA/RBT, status, times, duration, units, authorization, note, payroll', async () => {
    mount();
    await waitFor(/Raymond More/);
    const t = host.textContent;
    expect(t).toContain('Raymond More');           // child name, not id
    expect(t).toContain('Aman Khan');               // BCBA name (server-resolved)
    expect(t).toContain('Nia Patel');               // RBT name (server-resolved)
    expect(t).toContain('Approved');                // FROZEN → "Approved" (spec §6/§7)
    expect(t).not.toMatch(/\bFrozen\b/i);           // never the raw enum
    // ONE timing vocabulary: Clocked in / Clocked out / Worked Time. The old
    // "Duration" row duplicated the worked total and is deliberately gone.
    expect(t).toMatch(/Worked Time/);
    expect(t).not.toMatch(/Duration/);
    expect(t).not.toMatch(/Actual start|Actual end/);
    // Worked Time is minute-resolution here ("57m", "1h 05m"). Seconds belong
    // to the LIVE session timer, not to a completed session's record.
    expect(t).toMatch(/Worked Time\d+m/);
    expect(t).not.toMatch(/\d+m \d{2}s/);
    expect(t).toContain('ABA Therapy');             // resolved authorization label
    expect(t).toContain('Worked on functional communication and requesting.'); // note
    expect(t).toMatch(/Units/);                     // units row
    expect(t).toMatch(/Worked Time/);               // worked time (never money)
    // BCBA must not see money on this screen (spec §17)
    expect(t).not.toMatch(/\$/);
    expect(t).not.toMatch(/Hourly rate/i);
    expect(t).not.toMatch(/Payroll amount/i);
    // Only Clocked in/out for actual timing — no duplicate Actual start/end (spec §4)
    expect(t).toMatch(/Clocked in/);
    expect(t).toMatch(/Clocked out/);
    expect(t).not.toMatch(/Actual start/);
    expect(t).not.toMatch(/Actual end/);
    assertNoTechnicalIds();
  });

  it('does NOT render the Signatures & verification section (spec §7)', async () => {
    mount();
    await waitFor(/Raymond More/);
    const t = host.textContent;
    expect(t).not.toMatch(/Signatures & verification/i);
    expect(t).not.toMatch(/EVV/i);
    expect(t).not.toMatch(/Technician signature/i);
    expect(t).not.toMatch(/Guardian signature/i);
  });

  it('shows "Still in progress" for a live session end, not a blank dash (spec §4)', async () => {
    getSession.mockResolvedValue({
      ...DETAIL,
      session: { ...DETAIL.session, status: 'IN_PROGRESS', endedAt: null, clockOutAt: null },
      payroll: null,
    });
    mount();
    await waitFor(/Raymond More/);
    expect(host.textContent).toMatch(/Still in progress/);
  });

  it('shows a meaningful empty state when there is no session note', async () => {
    getSession.mockResolvedValue({ ...DETAIL, session: { ...DETAIL.session, narrative: null } });
    mount();
    await waitFor(/No session memo was recorded/);
    expect(host.textContent).toContain('No session memo was recorded.');
  });
});

/**
 * REGRESSION: "I have to open it twice."
 *
 * The page read `principal?.permissions ?? []`, so while the auth bootstrap was
 * still in flight it saw an EMPTY permission list — indistinguishable from "this
 * user may do nothing". The session loaded and the page rendered, but with every
 * action button missing. Navigating away and back gave the store time to
 * hydrate, and the actions appeared.
 *
 * "Not loaded yet" is not "denied". The page now waits for the principal the
 * same way it waits for the session.
 */
describe('SessionDetailRedesign — auth readiness', () => {
  afterEach(() => setAuth({ status: 'authenticated', principal: { permissions: ['sessions.read', 'sessions.review'] } }));

  it('does not render an action-less page while the principal is unknown', async () => {
    setAuth({ status: 'unknown', principal: null });
    mount();
    // The page holds its loading state rather than painting a complete-looking
    // screen whose actions are all silently missing.
    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent).join('|');
    expect(buttons).not.toMatch(/Approve|Submit|Send back|Amend/i);
  });

  it('renders the session once the principal has resolved', async () => {
    setAuth({ status: 'authenticated', principal: { permissions: ['sessions.read', 'sessions.review'] } });
    mount();
    await waitFor(/Session/i);
    expect(host.textContent).toMatch(/Session/i);
  });
});

/**
 * The redesigned Session Detail presents one timing vocabulary and groups the
 * page into clear sections. These pin the parts that are easy to regress.
 */
describe('SessionDetailRedesign — redesign', () => {
  it('uses ONE timing vocabulary: Clocked in, Clocked out, Worked Time', async () => {
    mount();
    await waitFor(/Session overview/);
    const t = host.textContent;
    expect(t).toMatch(/Clocked in/);
    expect(t).toMatch(/Clocked out/);
    expect(t).toMatch(/Worked Time/);
    // The old duplicate figures must not come back.
    expect(t).not.toMatch(/Duration/);
    expect(t).not.toMatch(/Actual start/);
    expect(t).not.toMatch(/Actual end/);
  });

  it('groups the page into the expected sections', async () => {
    mount();
    await waitFor(/Session overview/);
    const t = host.textContent;
    expect(t).toMatch(/Session overview/);
    expect(t).toMatch(/Session memo/);
  });

  it('still renders no technical identifiers or ISO timestamps', async () => {
    mount();
    await waitFor(/Session overview/);
    assertNoTechnicalIds();
  });
});

/**
 * MANUAL SESSION TIME ROUND TRIP (display leg). The server persists the exact
 * instants of the selected org-timezone wall clock (proven against a real
 * MongoDB in apps/api/test/manual-session-pipeline-db.test.js); this page must
 * read them back in the ORGANIZATION's timezone — never the browser's, never
 * the appointment's midnight, never "now".
 */
describe('SessionDetailRedesign — org timezone round trip', () => {
  const manual = (tz, startIso, endIso) => ({
    ...DETAIL,
    session: {
      ...DETAIL.session, source: 'MANUAL', status: 'FROZEN',
      startedAt: startIso, endedAt: endIso, clockInAt: startIso, clockOutAt: endIso,
      intervals: [{ startedAt: startIso, endedAt: endIso, workedMinutes: 90 }],
    },
    appointment: { ...DETAIL.appointment, startAt: startIso, endAt: endIso, timeSet: true },
    payroll: { ...DETAIL.payroll, workedMinutes: 90 },
  });
  const row = (label) => {
    const r = [...host.querySelectorAll('.rx-sd__row')].find((n) => n.querySelector('dt')?.textContent === label);
    return r ? r.querySelector('dd').textContent : null;
  };

  it('09/13/2026 10:15 AM → 11:45 AM (America/New_York) reads back exactly: Clocked in 10:15 AM, Clocked out 11:45 AM, Worked 1h 30m', async () => {
    orgTz.value = 'America/New_York';
    getSession.mockResolvedValue(manual('America/New_York', '2026-09-13T14:15:00.000Z', '2026-09-13T15:45:00.000Z'));
    mount();
    await waitFor(/Clocked in/);
    expect(row('Clocked in')).toBe('10:15 AM');
    expect(row('Clocked out')).toBe('11:45 AM');
    expect(row('Worked Time')).toBe('1h 30m');
    expect(row('Session date')).toBe('09/13/2026 · 10:15 AM – 11:45 AM');
    expect(host.textContent).toContain('Manual entry');
    expect(host.textContent).not.toMatch(/9:30 AM|12:00 AM/);
  });

  it('is independent of the browser timezone (org far from any device zone)', async () => {
    // 10:15 AM in Pacific/Kiritimati (UTC+14) is 20:15Z the previous day.
    orgTz.value = 'Pacific/Kiritimati';
    getSession.mockResolvedValue(manual('Pacific/Kiritimati', '2026-09-12T20:15:00.000Z', '2026-09-12T21:45:00.000Z'));
    mount();
    await waitFor(/Clocked in/);
    expect(row('Clocked in')).toBe('10:15 AM');
    expect(row('Clocked out')).toBe('11:45 AM');
    expect(row('Session date')).toBe('09/13/2026 · 10:15 AM – 11:45 AM');
  });

  it('a date-only appointment shows its date, never a fabricated 12:00 AM window', async () => {
    orgTz.value = 'America/New_York';
    getSession.mockResolvedValue({
      ...DETAIL,
      appointment: { ...DETAIL.appointment, startAt: '2026-09-13T04:00:00.000Z', endAt: '2026-09-14T04:00:00.000Z', timeSet: false },
    });
    mount();
    await waitFor(/Clocked in/);
    expect(row('Session date')).toBe('09/13/2026');
  });
});
