import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Company Admin — Today's appointment notes as notification-style entries.
 * Rows are the server's persisted current-day notes; each reads
 * "<Author first name> has added notes" (canonical formatter, never the
 * appointment's data, never an id). Clicking opens the actual note READ-ONLY:
 * BCBA, the note's selected client (only when one was selected), and the note.
 */
const listAppointmentNotesOverview = vi.fn();
const getAppointmentNote = vi.fn();
const saveAppointmentNote = vi.fn();
vi.mock('@/api/client', () => ({
  listAppointmentNotesOverview: (...a) => listAppointmentNotesOverview(...a),
  getAppointmentNote: (...a) => getAppointmentNote(...a),
  saveAppointmentNote: (...a) => saveAppointmentNote(...a),
  deleteAppointmentNote: vi.fn(),
  listClients: vi.fn(async () => ({ items: [] })),
}));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ principal: { roles: ['org_admin'] } }),
  useOrgTimezone: () => 'America/New_York',
}));

const ROWS = [
  // Appointment client is Raymond K, but the note has NO selected client.
  { id: 'n1', appointmentId: 'appt-ray', businessDate: '2026-09-13', authorStaffProfileId: 'bcba-1', authorFirstName: 'test1 john', updatedAt: '2026-09-13T14:05:00.000Z', bcbaName: 'test1 john J', appointmentClientName: 'Raymond K', noteClientId: null, noteClientName: null },
  { id: 'n2', appointmentId: 'appt-cam', businessDate: '2026-09-13', authorStaffProfileId: 'bcba-2', authorFirstName: 'PRIYA', updatedAt: '2026-09-13T15:30:00.000Z', bcbaName: 'Priya Shah', appointmentClientName: 'Cam Ng', noteClientId: 'client_bea', noteClientName: 'Bea Stone' },
];
const NOTES = {
  'appt-ray': { appointmentId: 'appt-ray', businessDate: '2026-09-13', exists: true, note: 'Ray note (no client).', clientId: null, clientName: null, authorFirstName: 'test1 john', canEdit: false },
  'appt-cam': { appointmentId: 'appt-cam', businessDate: '2026-09-13', exists: true, note: 'Plan with Bea.', clientId: 'client_bea', clientName: 'Bea Stone', authorFirstName: 'PRIYA', canEdit: false },
};

let host; let root; let mod;
beforeEach(async () => {
  mod = await import('./AppointmentNotesOverview.jsx');
  listAppointmentNotesOverview.mockReset(); getAppointmentNote.mockReset(); saveAppointmentNote.mockReset();
  listAppointmentNotesOverview.mockResolvedValue({ businessDate: '2026-09-13', items: ROWS });
  getAppointmentNote.mockImplementation(async (id) => NOTES[id]);
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { AppointmentNotesOverview } = mod;
  act(() => root.render(<QueryClientProvider client={qc}><AppointmentNotesOverview /></QueryClientProvider>));
};
const settle = async () => { for (let i = 0; i < 25; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const rows = () => [...host.querySelectorAll('.rx-notesov__row')];
const facts = (dialog) => Object.fromEntries([...dialog.querySelectorAll('.rx-apptnote__fact')].map((f) => [f.querySelector('dt').textContent, f.querySelector('dd').textContent]));
const openRow = async (re) => { await act(async () => { rows().find((r) => re.test(r.textContent)).click(); }); await settle(); };

describe('Today\'s appointment notes (Company Admin) — notifications', () => {
  it('one clean entry per persisted note: "<First> has added notes", capitalized, newest first, no ids or appointment data', async () => {
    mount(); await settle();
    expect(listAppointmentNotesOverview).toHaveBeenCalledWith();
    expect(host.textContent).toContain("Today's appointment notes");
    expect(host.textContent).toContain('09/13/2026');
    expect(rows().map((r) => r.querySelector('.rx-notesov__msg').textContent)).toEqual(['Priya has added notes', 'Test1 has added notes']);
    expect(rows()[1].textContent).toContain('10:05 AM'); // updatedAt in the org timezone
    expect(host.textContent).not.toMatch(/bcba-1|appt-ray|Raymond K|Cam Ng|test1 john/);
  });

  it('clicking "Test1 has added notes" opens the actual note read-only; no client selected → no client shown or inferred', async () => {
    mount(); await settle();
    await openRow(/Test1 has added notes/);
    expect(getAppointmentNote).toHaveBeenCalledWith('appt-ray');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent).toContain('Appointment Note');
    expect(facts(dialog)).toEqual({ BCBA: 'Test1', Note: 'Ray note (no client).' });
    expect(dialog.textContent).not.toMatch(/Raymond K/);
    // Read-only: no editor, no edit/delete/save actions.
    expect(dialog.querySelector('textarea')).toBeNull();
    expect([...dialog.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean)).toEqual([]);
    expect(dialog.textContent).not.toMatch(/Edit|Delete|Save|Add Note|No notes yet|Service date|All day/);
  });

  it('a note with a selected client shows that persisted client (not the appointment client)', async () => {
    mount(); await settle();
    await openRow(/Priya has added notes/);
    const dialog = document.querySelector('[role="dialog"]');
    expect(facts(dialog)).toEqual({ BCBA: 'Priya', Client: 'Bea Stone', Note: 'Plan with Bea.' });
    expect(dialog.textContent).not.toMatch(/Cam Ng/);
    expect(saveAppointmentNote).not.toHaveBeenCalled();
  });

  it('renders NOTHING when there are no notes today (no empty notification)', async () => {
    listAppointmentNotesOverview.mockResolvedValue({ businessDate: '2026-09-13', items: [] });
    mount(); await settle();
    expect(host.textContent).toBe('');
    expect(host.textContent).not.toMatch(/has added notes/);
  });

  it('renders nothing for a refused caller (403)', async () => {
    listAppointmentNotesOverview.mockRejectedValue(Object.assign(new Error('forbidden'), { response: { status: 403 } }));
    mount(); await settle();
    expect(host.textContent).toBe('');
  });

  it('authorLabel uses the canonical first-name formatter', () => {
    expect(mod.authorLabel('test1 john')).toBe('Test1 has added notes');
    expect(mod.authorLabel(null)).toBe('A BCBA has added notes');
  });
});
