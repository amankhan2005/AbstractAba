import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Email Templates — saved, reusable parent-email templates (/v1/email-templates).
 * Every list/create/edit/delete goes through the real API client; nothing is
 * rendered that the API did not return.
 */
const api = {
  listEmailTemplates: vi.fn(), createEmailTemplate: vi.fn(), updateEmailTemplate: vi.fn(), deleteEmailTemplate: vi.fn(), listClients: vi.fn(),
};
vi.mock('@/api/client', () => ({
  listEmailTemplates: (...a) => api.listEmailTemplates(...a),
  createEmailTemplate: (...a) => api.createEmailTemplate(...a),
  updateEmailTemplate: (...a) => api.updateEmailTemplate(...a),
  deleteEmailTemplate: (...a) => api.deleteEmailTemplate(...a),
  listClients: (...a) => api.listClients(...a),
}));
let permissions = [];
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ status: 'authenticated', principal: { permissions } }),
  useOrgTimezone: () => 'America/New_York',
}));

const VARS = ['childFirstName', 'parentFirstName', 'companyName', 'appointmentDate', 'appointmentTime'];
const REMINDER = { id: 't-1', name: 'Session reminder', subject: 'Reminder for {{childFirstName}}', body: 'Hello {{parentFirstName}},\n\nSee you soon.', createdAt: '2026-09-01T12:00:00Z', updatedAt: '2026-09-10T12:00:00Z', version: 2 };
const INTAKE = { id: 't-2', name: 'Intake follow-up', subject: 'Intake for {{childFirstName}}', body: 'Please return the forms.', createdAt: '2026-08-01T12:00:00Z', updatedAt: '2026-08-02T12:00:00Z', version: 1 };
const listOf = (items) => ({ items, supportedVariables: VARS });

let host; let root; let mod; let lastLocation;
function Probe() { lastLocation = useLocation(); return null; }

beforeEach(async () => {
  permissions = ['clients.update', 'organization.update'];
  for (const fn of Object.values(api)) fn.mockReset();
  api.listEmailTemplates.mockResolvedValue(listOf([REMINDER, INTAKE]));
  api.listClients.mockResolvedValue({ items: [{ id: 'c-mia', firstName: 'mia', lastName: 'k', clientNumber: 'CL-0001' }] });
  mod = await import('./EmailTemplatesPage.jsx');
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <MemoryRouter initialEntries={['/settings/email-templates']}>
        <Probe />
        <Routes>
          <Route path="/settings/email-templates" element={<mod.EmailTemplatesPage />} />
          <Route path="/clients/:clientId" element={<div>client profile</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  ));
};
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const text = () => document.body.textContent;
const button = (re, scope = document) => [...scope.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()) || re.test(b.getAttribute('aria-label') ?? ''));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); }); await settle(); };
const cards = () => [...host.querySelectorAll('.rx-et__card')];
const dialog = () => document.querySelector('[role="dialog"]');
const setValue = async (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const fieldError = (label) => [...document.querySelectorAll('.rx-formfield')].find((f) => f.querySelector('label')?.textContent.startsWith(label))?.querySelector('.rx-formfield__err')?.textContent.trim() ?? null;

describe('Email Templates — list', () => {
  it('shows the saved templates from the API with name, subject, readable variables and real dates', async () => {
    mount(); await settle();
    expect(host.querySelector('.rx-et__title').textContent).toBe('Email Templates');
    expect(button(/^Create Template$/)).toBeTruthy();
    expect(text()).toContain('2 saved templates');
    const [first] = cards();
    expect(first.querySelector('.rx-et__name').textContent).toBe('Session reminder');
    expect(first.querySelector('.rx-et__subject').textContent).toBe('SubjectReminder for Child first name');
    expect(first.querySelector('.rx-et__dates').textContent).toBe('Updated 09/10/2026 · Created 09/01/2026');
    expect([...first.querySelectorAll('button')].map((b) => b.textContent.trim() || b.getAttribute('aria-label'))).toEqual(['Use Template', 'Edit', 'Duplicate', 'Delete Session reminder']);
  });

  it('empty state offers Create Template; search filters the loaded list', async () => {
    api.listEmailTemplates.mockResolvedValueOnce(listOf([]));
    mount(); await settle();
    expect(text()).toContain('No saved templates yet');
    act(() => root.unmount()); host.remove(); root = undefined;
    mount(); await settle();
    await setValue(host.querySelector('input[type="search"]'), 'intake');
    expect(cards().map((c) => c.querySelector('.rx-et__name').textContent)).toEqual(['Intake follow-up']);
  });

  it('without organization.update: no Create/Edit/Delete, read-only View; without clients.update: no access and no request', async () => {
    permissions = ['clients.update'];
    mount(); await settle();
    expect(button(/^Create Template$/)).toBeUndefined();
    expect([...cards()[0].querySelectorAll('button')].map((b) => b.textContent.trim())).toEqual(['Use Template', 'View']);
    await click(button(/^View$/, cards()[0]));
    expect(dialog().querySelector('#et-name').readOnly).toBe(true);
    expect(button(/^Save Template$/)).toBeUndefined();
    act(() => root.unmount()); host.remove(); root = undefined;
    permissions = [];
    api.listEmailTemplates.mockClear();
    mount(); await settle();
    expect(text()).toContain('You don’t have access to email templates');
    expect(api.listEmailTemplates).not.toHaveBeenCalled();
  });

  it('loading skeleton and error with retry', async () => {
    api.listEmailTemplates.mockReturnValueOnce(new Promise(() => {}));
    mount(); await settle();
    expect(host.querySelector('[aria-label="Loading templates"]')).toBeTruthy();
    act(() => root.unmount()); host.remove(); root = undefined;
    api.listEmailTemplates.mockRejectedValueOnce({ response: { status: 500 } });
    mount(); await settle();
    expect(text()).toContain('We couldn’t load your templates');
    await click(button(/^Retry$/));
    expect(cards()).toHaveLength(2);
  });
});

describe('Email Templates — create, edit, delete', () => {
  it('create validates, inserts variables, persists through the API and the new template appears without a refresh', async () => {
    mount(); await settle();
    await click(button(/^Create Template$/));
    expect(dialog().textContent).toContain('Create Template');
    await click(button(/^Save Template$/));
    expect(fieldError('Template Name')).toBe('Template name is required.');
    expect(fieldError('Subject')).toBe('Subject is required.');
    expect(fieldError('Email Content')).toBe('Email content is required.');
    expect(api.createEmailTemplate).not.toHaveBeenCalled();

    await setValue(document.getElementById('et-name'), '  Welcome  ');
    await setValue(document.getElementById('et-subject'), 'Welcome {{childFirstName}}');
    await setValue(document.getElementById('et-body'), 'Hi {{guardianSsn}}');
    await click(button(/^Save Template$/));
    expect(fieldError('Email Content')).toBe('Unsupported variables: {{guardianSsn}}.');

    await setValue(document.getElementById('et-body'), 'Hello , welcome.');
    const body = document.getElementById('et-body');
    await act(async () => { body.focus(); body.setSelectionRange(6, 6); });
    await click(button(/Parent first name/));
    expect(body.value).toBe('Hello {{parentFirstName}}, welcome.');
    expect(dialog().querySelector('.rx-et__preview').textContent).toContain('Hello Parent first name, welcome.');

    const created = { id: 't-3', name: 'Welcome', subject: 'Welcome {{childFirstName}}', body: 'Hello {{parentFirstName}}, welcome.', createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T10:00:00Z', version: 1 };
    api.createEmailTemplate.mockResolvedValue(created);
    api.listEmailTemplates.mockResolvedValue(listOf([created, REMINDER, INTAKE]));
    await click(button(/^Save Template$/));
    expect(api.createEmailTemplate).toHaveBeenCalledWith({ name: 'Welcome', subject: 'Welcome {{childFirstName}}', body: 'Hello {{parentFirstName}}, welcome.' });
    expect(dialog()).toBeNull();
    expect(cards()[0].querySelector('.rx-et__name').textContent).toBe('Welcome');
    expect(text()).toContain('“Welcome” was saved.');
  });

  it('a duplicate name from the server is shown on the name field', async () => {
    mount(); await settle();
    await click(button(/^Create Template$/));
    await setValue(document.getElementById('et-name'), 'Session reminder');
    await setValue(document.getElementById('et-subject'), 'S');
    await setValue(document.getElementById('et-body'), 'B');
    api.createEmailTemplate.mockRejectedValue({ response: { status: 409, data: { error: { code: 'EMAIL_TEMPLATE_NAME_EXISTS', message: 'A template with this name already exists. Choose a different name.' } } } });
    await click(button(/^Save Template$/));
    expect(fieldError('Template Name')).toBe('A template with this name already exists. Choose a different name.');
    expect(dialog()).toBeTruthy();
  });

  it('edit opens the saved content, sends only changed fields with the version, and the change persists in the list', async () => {
    mount(); await settle();
    await click(button(/^Edit$/, cards()[0]));
    expect(dialog().textContent).toContain('Edit Template');
    expect(document.getElementById('et-body').value).toBe(REMINDER.body);
    await setValue(document.getElementById('et-subject'), 'Upcoming session for {{childFirstName}}');
    const updated = { ...REMINDER, subject: 'Upcoming session for {{childFirstName}}', version: 3, updatedAt: '2026-09-14T11:00:00Z' };
    api.updateEmailTemplate.mockResolvedValue(updated);
    api.listEmailTemplates.mockResolvedValue(listOf([updated, INTAKE]));
    await click(button(/^Save Template$/));
    expect(api.updateEmailTemplate).toHaveBeenCalledWith('t-1', { subject: 'Upcoming session for {{childFirstName}}' }, 2);
    expect(cards()[0].querySelector('.rx-et__subject').textContent).toBe('SubjectUpcoming session for Child first name');
    expect(text()).toContain('Template changes were saved.');
  });

  it('a version conflict is explained and the editor stays open', async () => {
    mount(); await settle();
    await click(button(/^Edit$/, cards()[0]));
    await setValue(document.getElementById('et-name'), 'Renamed');
    api.updateEmailTemplate.mockRejectedValue({ response: { status: 409, data: { error: { code: 'VERSION_CONFLICT', message: 'x' } } } });
    await click(button(/^Save Template$/));
    expect(dialog().querySelector('[role="alert"]').textContent).toContain('changed by someone else');
  });

  it('delete asks for confirmation, calls the API, and removes the template immediately', async () => {
    mount(); await settle();
    await click(button(/^Delete Session reminder$/));
    expect(dialog().textContent).toContain('Delete Template?');
    expect(dialog().textContent).toContain('“Session reminder” will be removed');
    expect(api.deleteEmailTemplate).not.toHaveBeenCalled();
    api.deleteEmailTemplate.mockResolvedValue({ id: 't-1', deleted: true });
    api.listEmailTemplates.mockResolvedValue(listOf([INTAKE]));
    await click(button(/^Delete Template$/, dialog()));
    expect(api.deleteEmailTemplate).toHaveBeenCalledWith('t-1');
    expect(cards().map((c) => c.querySelector('.rx-et__name').textContent)).toEqual(['Intake follow-up']);
    expect(text()).toContain('“Session reminder” was deleted.');
  });

  it('a delete refused by the server shows its message and keeps the template', async () => {
    mount(); await settle();
    await click(button(/^Delete Session reminder$/));
    api.deleteEmailTemplate.mockRejectedValue({ response: { status: 403, data: { error: { message: 'Missing permission: organization.update' } } } });
    await click(button(/^Delete Template$/, dialog()));
    expect(text()).toContain('Missing permission: organization.update');
    expect(cards()).toHaveLength(2);
  });

  it('duplicate creates a real copy with a unique name', async () => {
    mount(); await settle();
    api.createEmailTemplate.mockResolvedValue({ ...REMINDER, id: 't-4', name: 'Copy of Session reminder' });
    await click(button(/^Duplicate$/, cards()[0]));
    expect(api.createEmailTemplate).toHaveBeenCalledWith({ name: 'Copy of Session reminder', subject: REMINDER.subject, body: REMINDER.body });
    expect(mod.copyName('A', [{ name: 'Copy of A' }, { name: 'copy of a (2)' }])).toBe('Copy of A (3)');
  });

  it('Use Template chooses a client and opens their profile composer with the template', async () => {
    mount(); await settle();
    await click(button(/^Use Template$/, cards()[0]));
    expect(dialog().textContent).toContain('Choose the client to email with “Session reminder”');
    await click([...dialog().querySelectorAll('.rx-et__client')][0]);
    expect(lastLocation.pathname).toBe('/clients/c-mia');
    expect(lastLocation.search).toBe('?compose=t-1');
  });
});

describe('template validation helpers', () => {
  it('mirror the server allowlist and limits', () => {
    expect(mod.unsupportedTokens('Hi {{parentFirstName}} {{ssn}} {{ ssn }}', VARS)).toEqual(['ssn']);
    expect(mod.validateTemplate({ name: 'x'.repeat(121), subject: 'ok', body: 'ok' }, VARS).name).toMatch(/120 characters/);
    expect(mod.validateTemplate({ name: 'n', subject: 's', body: 'b' }, VARS)).toEqual({});
  });
});
