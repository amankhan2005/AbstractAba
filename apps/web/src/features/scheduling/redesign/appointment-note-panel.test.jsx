import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Appointment Note — CURRENT business date only, client never inherited.
 *
 * The component never sends a date; the server returns today's note or
 * `exists:false`. No note → no note card (BCBA gets only "Add appointment
 * note"; a reader gets nothing). The client selector starts EMPTY when creating
 * and is never the appointment's client. BCBA has Create / Edit / Delete.
 * RBT: nothing rendered and no request made.
 */
const getAppointmentNote = vi.fn();
const saveAppointmentNote = vi.fn();
const deleteAppointmentNote = vi.fn();
const listClients = vi.fn();
vi.mock('@/api/client', () => ({
  getAppointmentNote: (...a) => getAppointmentNote(...a),
  saveAppointmentNote: (...a) => saveAppointmentNote(...a),
  deleteAppointmentNote: (...a) => deleteAppointmentNote(...a),
  listClients: (...a) => listClients(...a),
}));
const auth = vi.hoisted(() => ({ roles: ['bcba'] }));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ principal: { roles: auth.roles } }),
  useOrgTimezone: () => 'America/New_York',
}));

let host; let root; let AppointmentNotePanel;
const NONE = { appointmentId: 'appt-ray', businessDate: '2026-09-13', exists: false, note: null, clientId: null, clientName: null, canEdit: true };
const NOTE = { ...NONE, exists: true, id: 'n1', note: 'Session plan for today.', authorName: 'Test1 J', updatedAt: '2026-09-13T14:00:00Z' };

beforeEach(async () => {
  // The fixtures are 09/13/2026 notes and the panel caches by the org business
  // date, so pin the clock to that date (11:00 AM ET) — never the real date.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-13T15:00:00Z'));
  ({ AppointmentNotePanel } = await import('./AppointmentNotePanel.jsx'));
  auth.roles = ['bcba'];
  getAppointmentNote.mockReset(); saveAppointmentNote.mockReset(); deleteAppointmentNote.mockReset(); listClients.mockReset();
  listClients.mockResolvedValue({ items: [
    { id: 'client_raymond', firstName: 'Raymond', lastName: 'K' },
    { id: 'client_bea', firstName: 'Bea', lastName: 'Stone' },
  ] });
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; vi.useRealTimers(); });

const mount = (props = {}) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><AppointmentNotePanel appointmentId="appt-ray" {...props} /></QueryClientProvider>));
};
const settle = async () => { for (let i = 0; i < 25; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const btn = (re) => [...document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); };
const type = async (el, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const selectedClientText = () => host.querySelector('.rx-select__value').textContent;
const choose = async (name) => { await click(host.querySelector('.rx-select__trigger')); await click([...document.querySelectorAll('.rx-select__opt')].find((o) => o.textContent.includes(name))); };
const FORBIDDEN = /No notes yet|No note recorded|Service date|All day|\bTime\b|Visible to|Not shared|RBTs?\b|administrators|2026-09-1\d/;

describe('BCBA — no current-day note', () => {
  it('shows NO note card and no "No notes yet" — only an "Add appointment note" action; never sends a date', async () => {
    getAppointmentNote.mockResolvedValue(NONE);
    mount(); await settle();
    expect(getAppointmentNote).toHaveBeenCalledWith('appt-ray');
    expect(host.querySelector('.rx-apptnote')).toBeNull();
    expect(host.textContent).toBe('Add appointment note');
    expect(host.textContent).not.toMatch(FORBIDDEN);
  });

  it('create: Client (Optional) starts EMPTY; saving without a client sends clientId null', async () => {
    getAppointmentNote.mockResolvedValue(NONE);
    saveAppointmentNote.mockResolvedValue({ ...NOTE });
    mount(); await settle();
    await click(btn(/^Add appointment note$/));
    expect(host.textContent).toContain('Client (Optional)');
    expect(selectedClientText()).toBe('Select client');
    expect(btn(/^Add Note$/).disabled).toBe(true);
    expect(btn(/^Delete$/)).toBeUndefined();
    await type(host.querySelector('textarea'), 'Session plan for today.');
    await click(btn(/^Add Note$/));
    expect(saveAppointmentNote).toHaveBeenCalledWith('appt-ray', { note: 'Session plan for today.', clientId: null });
    expect(host.querySelector('.rx-apptnote__body').textContent).toBe('Session plan for today.');
    expect(host.querySelector('.rx-apptnote__client')).toBeNull(); // no client selected → none shown
  });

  it('create with an explicitly selected client sends that client', async () => {
    getAppointmentNote.mockResolvedValue(NONE);
    saveAppointmentNote.mockResolvedValue({ ...NOTE, clientId: 'client_raymond', clientName: 'Raymond K' });
    mount(); await settle();
    await click(btn(/^Add appointment note$/));
    await choose('Raymond K');
    await type(host.querySelector('textarea'), 'With client.');
    await click(btn(/^Add Note$/));
    expect(saveAppointmentNote).toHaveBeenCalledWith('appt-ray', { note: 'With client.', clientId: 'client_raymond' });
    expect(host.querySelector('.rx-apptnote__client').textContent).toContain('Raymond K');
  });

  it('simple editor layout: note text first, then Client (Optional), then Cancel + Add Note', async () => {
    getAppointmentNote.mockResolvedValue(NONE);
    mount(); await settle();
    await click(btn(/^Add appointment note$/));
    const editor = host.querySelector('.rx-apptnote__editor');
    const textarea = editor.querySelector('textarea');
    expect(textarea.getAttribute('placeholder')).toBe('Write the appointment note...');
    const clientLabel = [...editor.querySelectorAll('.rx-apptnote__label')].find((l) => /Client/.test(l.textContent));
    // DOCUMENT_POSITION_FOLLOWING (4): the client field comes AFTER the note text.
    expect(textarea.compareDocumentPosition(clientLabel) & 4).toBe(4);
    expect([...editor.querySelectorAll('.rx-apptnote__actions button')].map((b) => b.textContent.trim())).toEqual(['Cancel', 'Add Note']);
    expect(host.textContent).not.toMatch(FORBIDDEN);
    expect(host.textContent).not.toMatch(/Raymond K/); // the appointment's client is never pre-filled
  });

  it('create: a client selected and then cleared is saved WITHOUT a client', async () => {
    getAppointmentNote.mockResolvedValue(NONE);
    saveAppointmentNote.mockResolvedValue({ ...NOTE });
    mount(); await settle();
    await click(btn(/^Add appointment note$/));
    await choose('Raymond K');
    expect(selectedClientText()).toContain('Raymond K');
    await click(host.querySelector('.rx-select__clear'));
    expect(selectedClientText()).toBe('Select client');
    await type(host.querySelector('textarea'), 'No client after all.');
    await click(btn(/^Add Note$/));
    expect(saveAppointmentNote).toHaveBeenCalledWith('appt-ray', { note: 'No client after all.', clientId: null });
  });

  it('Cancel closes the editor without saving', async () => {
    getAppointmentNote.mockResolvedValue(NONE);
    mount(); await settle();
    await click(btn(/^Add appointment note$/));
    await click(btn(/^Cancel$/));
    expect(saveAppointmentNote).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')).toBeNull();
  });
});

describe('BCBA — existing current-day note', () => {
  it('shows only the note content (no client line when none selected, no date/time/author metadata)', async () => {
    getAppointmentNote.mockResolvedValue(NOTE);
    mount(); await settle();
    expect(host.querySelector('h3').textContent).toBe('Appointment Note');
    expect(host.querySelector('.rx-apptnote__body').textContent).toBe('Session plan for today.');
    expect(host.querySelector('.rx-apptnote__client')).toBeNull();
    expect(host.textContent).not.toMatch(FORBIDDEN);
    expect(host.textContent).not.toMatch(/Last updated|Written by|\d{2}\/\d{2}\/\d{4}/);
  });

  it('edit: selector shows the note\'s saved client (or empty); select Raymond K → Save Changes sends it', async () => {
    getAppointmentNote.mockResolvedValue(NOTE);
    saveAppointmentNote.mockResolvedValue({ ...NOTE, clientId: 'client_raymond', clientName: 'Raymond K' });
    mount(); await settle();
    await click(btn(/^Edit$/));
    expect(selectedClientText()).toBe('Select client'); // saved without a client → still empty
    expect(btn(/^Save Changes$/).disabled).toBe(true);
    expect(btn(/^Delete$/)).toBeTruthy();
    await choose('Raymond K');
    await click(btn(/^Save Changes$/));
    expect(saveAppointmentNote).toHaveBeenCalledWith('appt-ray', { note: 'Session plan for today.', clientId: 'client_raymond' });
    expect(host.querySelector('.rx-apptnote__client').textContent).toContain('Raymond K');
  });

  it('edit: clearing the selected client sends clientId null', async () => {
    getAppointmentNote.mockResolvedValue({ ...NOTE, clientId: 'client_raymond', clientName: 'Raymond K' });
    saveAppointmentNote.mockResolvedValue({ ...NOTE });
    mount(); await settle();
    await click(btn(/^Edit$/));
    expect(selectedClientText()).toContain('Raymond K');
    await act(async () => { host.querySelector('.rx-select__clear').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    await click(btn(/^Save Changes$/));
    expect(saveAppointmentNote).toHaveBeenCalledWith('appt-ray', { note: 'Session plan for today.', clientId: null });
  });

  it('delete: confirm → DELETE called → note disappears (no empty card left behind)', async () => {
    getAppointmentNote.mockResolvedValue(NOTE);
    deleteAppointmentNote.mockResolvedValue({ deleted: true });
    mount(); await settle();
    await click(btn(/^Edit$/));
    await click(btn(/^Delete$/));
    expect(document.body.textContent).toContain('Delete appointment note?');
    getAppointmentNote.mockResolvedValue(NONE);
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === 'Delete');
    await click(confirm);
    expect(deleteAppointmentNote).toHaveBeenCalledWith('appt-ray');
    expect(host.querySelector('.rx-apptnote')).toBeNull();
    expect(host.textContent).toBe('Add appointment note');
  });

  it('server errors are shown in the editor', async () => {
    getAppointmentNote.mockResolvedValue(NONE);
    saveAppointmentNote.mockRejectedValue({ response: { data: { error: { message: 'Choose one of your assigned clients for this note.' } } } });
    mount(); await settle();
    await click(btn(/^Add appointment note$/));
    await type(host.querySelector('textarea'), 'x');
    await click(btn(/^Add Note$/));
    expect(host.querySelector('[role="alert"]').textContent).toBe('Choose one of your assigned clients for this note.');
  });
});

describe('Company Admin (read-only)', () => {
  it('existing note: content + the note\'s own selected client; no edit/delete', async () => {
    getAppointmentNote.mockResolvedValue({ ...NOTE, clientId: 'client_bea', clientName: 'Bea Stone', canEdit: false });
    mount(); await settle();
    expect(host.querySelector('.rx-apptnote__body').textContent).toBe('Session plan for today.');
    expect(host.querySelector('.rx-apptnote__client').textContent).toContain('Bea Stone');
    expect(btn(/Edit|Delete|Add appointment note/)).toBeUndefined();
  });

  it('existing note without a selected client: no client is invented', async () => {
    getAppointmentNote.mockResolvedValue({ ...NOTE, canEdit: false });
    mount(); await settle();
    expect(host.querySelector('.rx-apptnote__client')).toBeNull();
    expect(host.textContent).not.toMatch(/Raymond/);
  });

  it('no current-day note: renders NOTHING (no empty card, no "No notes yet")', async () => {
    getAppointmentNote.mockResolvedValue({ ...NONE, canEdit: false });
    mount(); await settle();
    expect(host.textContent).toBe('');
  });
});

describe('RBT', () => {
  it('renders nothing and never requests the note', async () => {
    auth.roles = ['rbt'];
    getAppointmentNote.mockResolvedValue(NOTE);
    mount(); await settle();
    expect(host.textContent).toBe('');
    expect(getAppointmentNote).not.toHaveBeenCalled();
  });

  it('a 403 from the server also renders nothing', async () => {
    getAppointmentNote.mockRejectedValue(Object.assign(new Error('forbidden'), { response: { status: 403 } }));
    mount(); await settle();
    expect(host.textContent).toBe('');
  });
});

describe('cache is scoped to the current business date', () => {
  it('a note cached on 09/13 is NOT served on 09/14 — a fresh current-day read happens', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-13T15:00:00Z')); // 11:00 AM ET on 09/13
      getAppointmentNote.mockResolvedValue({ ...NOTE, clientId: 'client_bea', clientName: 'Bea Stone' });
      host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
      const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      const render = () => act(() => root.render(<QueryClientProvider client={qc2}><AppointmentNotePanel appointmentId="appt-ray" /></QueryClientProvider>));
      render(); await settle();
      expect(host.querySelector('.rx-apptnote__body').textContent).toBe('Session plan for today.');
      expect(qc2.getQueryData(['appointment-note', 'appt-ray', '2026-09-13'])).toBeTruthy();

      // Next business day. Even with an infinite staleTime, the 09/13 entry is not reused.
      vi.setSystemTime(new Date('2026-09-14T15:00:00Z'));
      getAppointmentNote.mockResolvedValue({ ...NONE, businessDate: '2026-09-14', canEdit: false });
      render(); await settle();
      expect(getAppointmentNote).toHaveBeenCalledTimes(2);
      expect(host.textContent).toBe('');
      expect(host.textContent).not.toMatch(/Bea Stone|Session plan/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BCBA — Client dropdown is never clipped by the note card', () => {
  it('opens outside the card (portal), searches, selects, closes on Escape and on an outside click', async () => {
    getAppointmentNote.mockResolvedValue(NONE);
    mount(); await settle();
    await click(btn(/^Add appointment note$/));
    const card = host.querySelector('.rx-apptnote');

    await click(host.querySelector('.rx-select__trigger'));
    const menu = document.querySelector('.rx-select__menu');
    expect(menu).toBeTruthy();
    expect(card.contains(menu)).toBe(false);                       // escapes overflow:hidden
    expect(menu.classList.contains('rx-select__menu--floating')).toBe(true);

    // Search filters the options.
    const search = menu.querySelector('.rx-select__search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'Ray');
    await act(async () => { search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect([...document.querySelectorAll('.rx-select__opt')].every((o) => /Ray/i.test(o.textContent))).toBe(true);

    // Escape (pressed in the search box inside the portal) closes the menu.
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(host.querySelector('.rx-select__trigger').getAttribute('aria-expanded')).toBe('false');

    // Open again, select, and it closes with the choice shown.
    await choose('Raymond K');
    expect(selectedClientText()).toContain('Raymond K');
    expect(host.querySelector('.rx-select__trigger').getAttribute('aria-expanded')).toBe('false');

    // Outside click closes.
    await click(host.querySelector('.rx-select__trigger'));
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(host.querySelector('.rx-select__trigger').getAttribute('aria-expanded')).toBe('false');
  });
});
