import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { civilDateString } from '@/lib/businessDate';

/**
 * Scheduling page wiring for Appointment Notes with a MULTI-DATE appointment
 * (yesterday → +17 days, covering today). Notes are current-business-date
 * only: note UI appears only in TODAY's day view, never on another date of the
 * range; no empty note card anywhere; RBT gets no note UI and no request.
 */
const auth = vi.hoisted(() => ({ permissions: [], roles: [] }));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ status: 'authenticated', principal: { permissions: auth.permissions, roles: auth.roles } }),
  useOrgTimezone: () => 'UTC',
}));
const listAppointmentNotesOverview = vi.fn();
const getAppointmentNote = vi.fn();
const DAY = 86400000;
const todayKey = civilDateString(new Date(), 'UTC');
const startOfToday = Date.parse(`${todayKey}T00:00:00.000Z`);
vi.mock('@/api/client', () => ({
  listAppointments: vi.fn(async () => ({ items: [{
    id: 'appt-ray', clientId: 'client_raymond', bcbaId: 'bcba-1', rbtId: 'rbt-1', status: 'SCHEDULED', timeSet: false,
    startAt: new Date(startOfToday - DAY).toISOString(), endAt: new Date(startOfToday + 18 * DAY).toISOString(),
  }] })),
  listClients: vi.fn(async () => ({ items: [{ id: 'client_raymond', firstName: 'Raymond', lastName: 'K' }] })),
  listStaff: vi.fn(async () => ({ items: [{ id: 'bcba-1', firstName: 'Test1', lastName: 'J' }, { id: 'rbt-1', firstName: 'Nia', lastName: 'Patel' }] })),
  listAuthorizations: vi.fn(async () => ({ items: [] })),
  listCareTeam: vi.fn(async () => []),
  bookAppointment: vi.fn(), createServiceAuthorization: vi.fn(), transitionServiceAuthorization: vi.fn(), listServiceAuthorizations: vi.fn(async () => []),
  listAppointmentNotesOverview: (...a) => listAppointmentNotesOverview(...a),
  getAppointmentNote: (...a) => getAppointmentNote(...a),
  saveAppointmentNote: vi.fn(),
  deleteAppointmentNote: vi.fn(),
}));
vi.mock('@/components', () => ({ useToast: () => ({ push: () => {} }) }));

let host; let root; let SchedulingRedesign;
beforeEach(async () => {
  ({ SchedulingRedesign } = await import('./SchedulingRedesign.jsx'));
  listAppointmentNotesOverview.mockReset(); getAppointmentNote.mockReset();
  listAppointmentNotesOverview.mockResolvedValue({ businessDate: todayKey, items: [] });
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><MemoryRouter><SchedulingRedesign /></MemoryRouter></QueryClientProvider>));
};
const settle = async () => { for (let i = 0; i < 30; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const openDay = async (selector) => { const cell = document.querySelector(selector); await act(async () => { cell.click(); }); await settle(); return document.querySelector('[aria-label="Selected date"]'); };
const as = (who) => {
  if (who === 'admin') { auth.permissions = ['scheduling.read', 'scheduling.write']; auth.roles = ['org_admin']; }
  if (who === 'bcba') { auth.permissions = ['scheduling.read', 'documents.read', 'documents.write']; auth.roles = ['bcba']; }
  if (who === 'rbt') { auth.permissions = ['scheduling.read', 'documents.write']; auth.roles = ['rbt']; }
};
const NONE = { appointmentId: 'appt-ray', businessDate: todayKey, exists: false, note: null, clientId: null, clientName: null, canEdit: true };

describe('Scheduling — Appointment Notes are current-date only', () => {
  it('BCBA, today: appointment info shown; no note → only "Add appointment note", no empty note card', async () => {
    as('bcba');
    getAppointmentNote.mockResolvedValue(NONE);
    mount(); await settle();
    const drawer = await openDay('.rx-sch__cell.is-today');
    expect(drawer.querySelector('.rx-sch__appt-client').textContent).toBe('Raymond K');
    expect(drawer.querySelector('.rx-sch__appt-people').textContent).toContain('BCBATest1 J');
    expect(drawer.querySelector('.rx-sch__appt-people').textContent).toContain('RBTNia Patel');
    expect(getAppointmentNote).toHaveBeenCalledWith('appt-ray');
    expect(drawer.querySelector('.rx-apptnote')).toBeNull();
    expect(drawer.textContent).toContain('Add appointment note');
    expect(drawer.textContent).not.toMatch(/No notes yet|No note recorded|All day|Date only|Service date/);
    expect(document.querySelector('.rx-notesov__row')).toBeNull(); // BCBA doesn't get the admin overview
  });

  it('another date of the SAME multi-date appointment shows NO note UI and makes NO note request', async () => {
    as('bcba');
    getAppointmentNote.mockResolvedValue(NONE);
    mount(); await settle();
    // Pick a day inside the range that is not today (tomorrow, or yesterday at month end).
    const cells = [...document.querySelectorAll('.rx-sch__cell')];
    const idx = cells.findIndex((c) => c.classList.contains('is-today'));
    const other = cells[idx + 1] && !cells[idx + 1].classList.contains('is-out') ? cells[idx + 1] : cells[idx - 1];
    // Today is selected by default (its note is legitimately loaded); choosing another date must add no request.
    const before = getAppointmentNote.mock.calls.length;
    await act(async () => { other.click(); }); await settle();
    const drawer = document.querySelector('[aria-label="Selected date"]');
    expect(drawer.querySelector('.rx-sch__appt-client').textContent).toBe('Raymond K');
    expect(drawer.textContent).not.toMatch(/Appointment Note|Add appointment note/);
    expect(getAppointmentNote.mock.calls.length).toBe(before);
  });

  it('Company Admin: today\'s note shown only when it exists; no note → nothing; overview hidden when empty', async () => {
    as('admin');
    getAppointmentNote.mockResolvedValue({ ...NONE, canEdit: false });
    mount(); await settle();
    expect(document.querySelector('.rx-notesov__row')).toBeNull();
    let drawer = await openDay('.rx-sch__cell.is-today');
    expect(drawer.textContent).not.toMatch(/Appointment Note|No notes yet|Add appointment note/);

    root.unmount(); host.remove(); document.body.innerHTML = '';
    getAppointmentNote.mockResolvedValue({ ...NONE, exists: true, note: 'Plan for today.', canEdit: false });
    listAppointmentNotesOverview.mockResolvedValue({ businessDate: todayKey, items: [
      { id: 'n1', appointmentId: 'appt-ray', businessDate: todayKey, authorStaffProfileId: 'bcba-1', authorFirstName: 'test1', updatedAt: null, bcbaName: 'Test1 J', appointmentClientName: 'Raymond K', rbtName: 'Nia Patel', status: 'SCHEDULED', noteClientId: null, noteClientName: null },
    ] });
    mount(); await settle();
    expect(document.querySelector('.rx-notesov__row').textContent).toContain('Test1 has added notes');
    drawer = await openDay('.rx-sch__cell.is-today');
    expect(drawer.querySelector('.rx-apptnote__body').textContent).toBe('Plan for today.');
    expect(drawer.querySelector('.rx-apptnote__client')).toBeNull(); // no client invented from the appointment
  });

  it('RBT: no note UI and no note or overview request', async () => {
    as('rbt');
    getAppointmentNote.mockResolvedValue(NONE);
    mount(); await settle();
    const drawer = await openDay('.rx-sch__cell.is-today');
    expect(drawer.textContent).not.toMatch(/Appointment Note|Add appointment note/);
    expect(getAppointmentNote).not.toHaveBeenCalled();
    expect(listAppointmentNotesOverview).not.toHaveBeenCalled();
  });
});
