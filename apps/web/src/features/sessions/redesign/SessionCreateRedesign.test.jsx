import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * SessionCreateRedesign (/sessions/new) — spec §6/§7/§8/§14/§15/§32.
 *  • Appointments read as "Child — MM/DD/YYYY • time" with NO UUID anywhere.
 *  • A date-only appointment shows the date only (no fabricated midnight).
 *  • The treatment plan is OPTIONAL: with no active plans the RBT still reaches
 *    the review step and can create the session (the empty plan id is never
 *    sent — the 422 this removes).
 */

const IDS = {
  appt: '01a051e4-c8fd-71a1-b09e-3e86422eb6c2',
  apptDateOnly: '02b162f5-d9fe-72b2-c1af-4f97533fc7d3',
  child: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
};

const listAppointments = vi.fn();
const listPlans = vi.fn();
const listClients = vi.fn();
const createSession = vi.fn(() => Promise.resolve({ id: 'sess-1' }));

vi.mock('@/api/client', () => ({
  listAppointments: (...a) => listAppointments(...a),
  listPlans: (...a) => listPlans(...a),
  listClients: (...a) => listClients(...a),
  createSession: (...a) => createSession(...a),
}));
vi.mock('@/components', () => ({ useToast: () => ({ push: () => {} }) }));

let host; let root; let SessionCreateRedesign;

beforeEach(async () => {
  ({ SessionCreateRedesign } = await import('./SessionCreateRedesign.jsx'));
  listAppointments.mockReset(); listPlans.mockReset(); listClients.mockReset(); createSession.mockClear();
  listClients.mockResolvedValue({ items: [{ id: IDS.child, firstName: 'John', lastName: 'Smith' }] });
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
});

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><MemoryRouter><SessionCreateRedesign /></MemoryRouter></QueryClientProvider>,
  ));
};
const settle = async () => { for (let i = 0; i < 40; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const qa = (sel) => [...host.querySelectorAll(sel)];
const selectByLabel = async (labelText, optionRe) => {
  const field = qa('.rx-formfield').find((f) => f.textContent.includes(labelText));
  const trigger = field.querySelector('.rx-select__trigger');
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  const opt = qa('.rx-select__opt').find((o) => optionRe.test(o.textContent));
  await act(async () => { opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const clickButton = async (re) => {
  const btn = qa('button').find((b) => re.test(b.textContent));
  await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('SessionCreateRedesign — friendly labels + optional plan', () => {
  it('renders appointments as "Child — date • time" with no UUID, and date-only shows date only', async () => {
    listAppointments.mockResolvedValue({ items: [
      { id: IDS.appt, clientId: IDS.child, startAt: '2026-09-08T17:30:00.000Z', endAt: '2026-09-08T18:30:00.000Z', timeSet: true, status: 'SCHEDULED' },
      { id: IDS.apptDateOnly, clientId: IDS.child, startAt: '2026-09-09T00:00:00.000Z', timeSet: false, status: 'SCHEDULED' },
    ] });
    listPlans.mockResolvedValue({ items: [] });
    mount(); await settle();
    const field = qa('.rx-formfield').find((f) => f.textContent.includes('Appointment'));
    const trigger = field.querySelector('.rx-select__trigger');
    await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    await settle();
    const opts = qa('.rx-select__opt').map((o) => o.textContent);
    expect(opts.join(' | ')).toMatch(/John Smith — 09\/08\/2026 •/);         // child + date + time
    expect(opts.some((o) => /John Smith — 09\/09\/2026$/.test(o.trim()))).toBe(true); // date-only: no time
    expect(host.textContent).not.toMatch(UUID_RE);                            // never a raw id
  });

  it('lets the RBT reach review and create WITHOUT a treatment plan (no plan id sent)', async () => {
    listAppointments.mockResolvedValue({ items: [
      { id: IDS.appt, clientId: IDS.child, startAt: '2026-09-08T17:30:00.000Z', endAt: '2026-09-08T18:30:00.000Z', timeSet: true, status: 'SCHEDULED' },
    ] });
    listPlans.mockResolvedValue({ items: [] }); // no active plans
    mount(); await settle();
    // pick the appointment (opens the field's select and clicks the option)
    await selectByLabel('Appointment', /John Smith/);
    await settle();
    // Continue → plan step, Continue → review, Create. (The plan step is
    // optional; the wizard advances without a plan being chosen.)
    await clickButton(/Continue/);
    await settle();
    await clickButton(/Continue/);
    await settle();
    await clickButton(/Create & start capture/);
    await settle();
    expect(createSession).toHaveBeenCalledTimes(1);
    const body = createSession.mock.calls[0][0];
    expect(body.appointmentId).toBe(IDS.appt);
    expect(body).not.toHaveProperty('treatmentPlanId'); // optional → omitted, never '' (the 422)
  });
});
