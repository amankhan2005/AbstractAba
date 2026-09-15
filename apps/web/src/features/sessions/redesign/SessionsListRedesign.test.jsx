import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Review queue (SessionsListRedesign) — spec §F/§G. Proves the list shows child
 * and clinician NAMES, a human date/time, a status label and the actual worked
 * duration, groups today's sessions, and NEVER renders a raw client/staff id or
 * ISO timestamp.
 */
const CHILD = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const STAFF = 'b1e2c3d4-e5f6-4789-abcd-0123456789ab';

const listSessions = vi.fn();
const listClients = vi.fn(() => Promise.resolve({ items: [{ id: CHILD, firstName: 'Raymond', lastName: 'More' }] }));
const listStaff = vi.fn(() => Promise.resolve({ items: [{ id: STAFF, firstName: 'Nia', lastName: 'Patel' }] }));

vi.mock('@/api/client', () => ({
  listSessions: (...a) => listSessions(...a),
  listClients: (...a) => listClients(...a),
  listStaff: (...a) => listStaff(...a),
}));

let host; let root; let SessionsListRedesign;
beforeEach(async () => { ({ SessionsListRedesign } = await import('./SessionsListRedesign.jsx')); listSessions.mockReset(); });
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><MemoryRouter><SessionsListRedesign /></MemoryRouter></QueryClientProvider>,
  ));
};
const waitFor = async (re) => { for (let i = 0; i < 80; i += 1) { if (re.test(host.textContent)) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); } throw new Error(`text ${re} not found in: ${host.textContent.slice(0, 300)}`); };

describe('SessionsListRedesign (review queue)', () => {
  it('renders child/clinician names, duration and a status label, with no ids or ISO strings', async () => {
    const started = new Date(); started.setHours(9, 50, 0, 0);
    const ended = new Date(started.getTime() + 62 * 60000); // 1h 02m
    listSessions.mockResolvedValue({ items: [
      { id: 'sess-1', clientId: CHILD, staffProfileId: STAFF, startedAt: started.toISOString(), endedAt: ended.toISOString(), status: 'FROZEN' },
    ] });
    mount();
    await waitFor(/Raymond More/);
    expect(host.textContent).toContain('Raymond More');   // child name, not id
    expect(host.textContent).toContain('Nia Patel');       // clinician name, not id
    expect(host.textContent).toContain('1h 02m');          // actual duration
    expect(host.textContent).toContain('Approved');        // FROZEN → "Approved" label, not the raw enum
    expect(host.textContent).not.toMatch(/\bFrozen\b/i);
    expect(host.textContent).toContain("Today's sessions"); // today grouping (§G)

    const text = host.textContent;
    expect(text).not.toContain(CHILD);
    expect(text).not.toContain(STAFF);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

/**
 * REGRESSION: the queue "only works the second time you open it".
 *
 * Child and Clinician are resolved by useBcbaNames(), which issues its own two
 * requests. Those were not part of the table's loading gate, so on a COLD visit
 * the table painted immediately with every name showing its neutral placeholder
 * ("Child", "Assigned RBT") and only re-rendered once the directories landed.
 * A revisit served both from cache, so names were right instantly — which is
 * exactly what "I have to go back and reopen it" looks like.
 *
 * The gate now covers the directories too. The three requests still run in
 * PARALLEL, so this costs no extra round trip; it only suppresses the
 * half-resolved paint.
 */
describe('SessionsListRedesign — first-visit name resolution', () => {
  // The directory mocks are module-level and shared, so their call counts
  // accumulate across tests unless reset here.
  beforeEach(() => {
    listClients.mockReset();
    listStaff.mockReset();
    listClients.mockResolvedValue({ items: [{ id: CHILD, firstName: 'Raymond', lastName: 'More' }] });
    listStaff.mockResolvedValue({ items: [{ id: STAFF, firstName: 'Nia', lastName: 'Patel' }] });
  });

  const SESSION = {
    id: 's-1', clientId: CHILD, staffProfileId: STAFF, status: 'SUBMITTED',
    startedAt: '2026-09-12T14:00:00.000Z', endedAt: '2026-09-12T15:00:00.000Z', workedMinutes: 60,
  };

  it('never paints placeholder names before the directories resolve', async () => {
    listSessions.mockResolvedValue({ items: [SESSION] });
    // The directories resolve LATER than the sessions request — the cold-visit
    // ordering that produced the flash.
    let releaseClients;
    listClients.mockImplementationOnce(() => new Promise((r) => { releaseClients = () => r({ items: [{ id: CHILD, firstName: 'Raymond', lastName: 'More' }] }); }));

    mount();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    // Sessions have arrived but the client directory has not. The table must
    // NOT be showing a row with the placeholder name.
    expect(host.textContent).not.toMatch(/\bChild\b(?!ren)/);

    releaseClients();
    for (let i = 0; i < 40 && !/Raymond More/.test(host.textContent); i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(host.textContent).toMatch(/Raymond More/);
  });

  it('requests sessions, clients and staff exactly once each per visit', async () => {
    listSessions.mockResolvedValue({ items: [SESSION] });
    mount();
    for (let i = 0; i < 40 && !/Raymond More/.test(host.textContent); i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    // No duplicate fetches from re-renders, effects or unstable query keys.
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listClients).toHaveBeenCalledTimes(1);
    expect(listStaff).toHaveBeenCalledTimes(1);
  });

  it('summary counts come from the real rows, not invented numbers', async () => {
    listSessions.mockResolvedValue({
      items: [
        { ...SESSION, id: 'a', status: 'SUBMITTED' },
        { ...SESSION, id: 'b', status: 'SUBMITTED' },
        { ...SESSION, id: 'c', status: 'FROZEN' },
      ],
    });
    mount();
    for (let i = 0; i < 40 && !/Raymond More/.test(host.textContent); i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    const text = host.textContent;
    expect(text).toMatch(/Pending review/);
    expect(text).toMatch(/Total sessions/);
    // 2 submitted, 1 reviewed, 3 total — all counted from the rows above.
    expect(text).toMatch(/Pending review\s*2/);
    expect(text).toMatch(/Total sessions\s*3/);
  });
});
