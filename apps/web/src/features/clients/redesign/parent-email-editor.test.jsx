import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Child dashboard → Send email: the redesigned template experience.
 *   - library of saved + built-in templates with search, loading and error states;
 *   - managers create / edit / delete SAVED templates here through the same
 *     /v1/email-templates API and editor as Settings (no second system);
 *   - non-managers can use templates but not manage them;
 *   - "Save as template" keeps a composed email for reuse;
 *   - using a template → edit → review → send via the existing parent-email path.
 * Any React act() warning fails the test.
 */
const api = vi.hoisted(() => ({
  fetchParentEmailTemplates: vi.fn(), listEmailTemplates: vi.fn(), createEmailTemplate: vi.fn(), updateEmailTemplate: vi.fn(), deleteEmailTemplate: vi.fn(),
  previewParentEmail: vi.fn(), sendParentEmail: vi.fn(), listClients: vi.fn(),
}));
vi.mock('@/api/client', () => Object.fromEntries(Object.keys(api).map((k) => [k, (...a) => api[k](...a)])));
let permissions = [];
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { permissions } }) }));

const VARS = ['childFirstName', 'parentFirstName', 'companyName', 'appointmentDate', 'appointmentTime'];
const SAVED = { id: 't-1', name: 'Session reminder', subject: 'Reminder for {{childFirstName}}', body: 'Hello {{parentFirstName}}', updatedAt: '2026-09-10T12:00:00Z', version: 2 };
const BUILT_IN = { id: 'welcome', name: 'Welcome to services', category: 'Onboarding', description: 'First message to a new family', subject: 'Welcome', body: 'Hi', supportedVariables: VARS };
const PREVIEW = { subject: 'Reminder for Mia', bodyText: 'Hello Sarah', recipient: { available: true, name: 'Sarah Khan', email: 'sarah@example.com' }, sender: { name: 'Acme ABA' }, unavailableVariables: [] };

let consoleErrorSpy; let host; let root; let ParentEmailEditor; let onClose;
beforeEach(async () => {
  ({ ParentEmailEditor } = await import('./ParentEmailEditor.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  for (const fn of Object.values(api)) fn.mockReset();
  permissions = ['clients.read', 'clients.update', 'organization.update'];
  api.fetchParentEmailTemplates.mockResolvedValue([BUILT_IN]);
  api.listEmailTemplates.mockResolvedValue({ items: [SAVED], supportedVariables: VARS });
  api.previewParentEmail.mockResolvedValue(PREVIEW);
  onClose = vi.fn();
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove(); document.body.innerHTML = '';
  root = undefined; host = undefined;
  const w = consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
  consoleErrorSpy.mockRestore();
  expect(w).toHaveLength(0);
});

const mount = (props = {}) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider><MemoryRouter><ParentEmailEditor clientId="c-1" onClose={onClose} {...props} /></MemoryRouter></ToastProvider></QueryClientProvider>,
  ));
};
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const composer = () => dialogs()[0];
const top = () => dialogs().at(-1);
const button = (re, scope = document) => [...scope.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()) || re.test(b.getAttribute('aria-label') ?? ''));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }); await settle(); };
const setValue = async (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const names = (section) => [...composer().querySelectorAll(`[aria-label="${section}"] .rx-pe__option-name`)].map((n) => n.textContent);

describe('Send email — template library', () => {
  it('lists saved and built-in templates with counts, manage link and step indicator; search filters both', async () => {
    mount(); await settle();
    expect(composer().querySelector('[aria-current="step"]').textContent).toContain('Choose template');
    expect(names('Saved templates')).toEqual(['Session reminder']);
    expect(names('Built-in templates')).toEqual(['Welcome to services']);
    expect(composer().querySelector('[aria-label="Saved templates"] .rx-pe__option-desc').textContent).toBe('Reminder for Child first name');
    expect(composer().querySelector('.rx-pe__manage').getAttribute('href')).toBe('/settings/email-templates');
    await setValue(composer().querySelector('input[type="search"]'), 'welcome');
    expect(names('Saved templates')).toEqual([]);
    expect(composer().textContent).toContain('No saved templates match “welcome”');
    expect(names('Built-in templates')).toEqual(['Welcome to services']);
  });

  it('loading skeleton, then an error with retry', async () => {
    api.fetchParentEmailTemplates.mockReturnValueOnce(new Promise(() => {}));
    mount(); await settle();
    expect(composer().querySelector('[aria-label="Loading templates"]')).toBeTruthy();
    act(() => root.unmount()); host.remove(); root = undefined;
    api.fetchParentEmailTemplates.mockRejectedValueOnce({ response: { status: 500 } });
    mount(); await settle();
    expect(composer().textContent).toContain('We couldn’t load the templates');
    await click(button(/^Retry$/, composer()));
    expect(names('Built-in templates')).toEqual(['Welcome to services']);
  });

  it('empty saved list invites managers to create a template', async () => {
    api.listEmailTemplates.mockResolvedValue({ items: [], supportedVariables: VARS });
    mount(); await settle();
    expect(composer().querySelector('.rx-pe__empty').textContent).toContain('No saved templates yet');
    expect(button(/^Create Template$/, composer().querySelector('.rx-pe__empty'))).toBeTruthy();
  });

  it('users without organization.update can use templates but not create, edit or delete them', async () => {
    permissions = ['clients.read', 'clients.update'];
    mount(); await settle();
    expect(button(/^Create Template$/, composer())).toBeUndefined();
    expect(button(/^Edit Session reminder$/, composer())).toBeUndefined();
    expect(button(/^Delete Session reminder$/, composer())).toBeUndefined();
    expect(button(/^Save as template$/, composer())).toBeUndefined();
  });
});

describe('Send email — manage saved templates in place', () => {
  it('Create Template persists through the API and the new template appears in the library', async () => {
    const created = { id: 't-2', name: 'Intake follow-up', subject: 'Forms for {{childFirstName}}', body: 'Please return the forms.', updatedAt: '2026-09-14T10:00:00Z', version: 1 };
    api.createEmailTemplate.mockResolvedValue(created);
    mount(); await settle();
    await click(button(/^Create Template$/, composer()));
    expect(top().textContent).toContain('Create Template');
    await setValue(document.getElementById('et-name'), 'Intake follow-up');
    await setValue(document.getElementById('et-subject'), 'Forms for {{childFirstName}}');
    await setValue(document.getElementById('et-body'), 'Please return the forms.');
    api.listEmailTemplates.mockResolvedValue({ items: [created, SAVED], supportedVariables: VARS });
    await click(button(/^Save Template$/, top()));
    expect(api.createEmailTemplate).toHaveBeenCalledWith({ name: 'Intake follow-up', subject: 'Forms for {{childFirstName}}', body: 'Please return the forms.' });
    expect(dialogs()).toHaveLength(1);
    expect(names('Saved templates')).toEqual(['Intake follow-up', 'Session reminder']);
  });

  it('Edit updates the saved template with its version', async () => {
    const updated = { ...SAVED, subject: 'Upcoming session for {{childFirstName}}', version: 3 };
    api.updateEmailTemplate.mockResolvedValue(updated);
    mount(); await settle();
    await click(button(/^Edit Session reminder$/, composer()));
    expect(top().textContent).toContain('Edit Template');
    await setValue(document.getElementById('et-subject'), 'Upcoming session for {{childFirstName}}');
    api.listEmailTemplates.mockResolvedValue({ items: [updated], supportedVariables: VARS });
    await click(button(/^Save Template$/, top()));
    expect(api.updateEmailTemplate).toHaveBeenCalledWith('t-1', { subject: 'Upcoming session for {{childFirstName}}' }, 2);
    expect(composer().querySelector('[aria-label="Saved templates"] .rx-pe__option-desc').textContent).toBe('Upcoming session for Child first name');
  });

  it('Delete asks for confirmation, calls the API and removes the template', async () => {
    api.deleteEmailTemplate.mockResolvedValue({ id: 't-1', deleted: true });
    mount(); await settle();
    await click(button(/^Delete Session reminder$/, composer()));
    expect(top().textContent).toContain('Delete Template?');
    expect(api.deleteEmailTemplate).not.toHaveBeenCalled();
    api.listEmailTemplates.mockResolvedValue({ items: [], supportedVariables: VARS });
    await click(button(/^Delete Template$/, top()));
    expect(api.deleteEmailTemplate).toHaveBeenCalledWith('t-1');
    expect(names('Saved templates')).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Send email — compose, save as template, send', () => {
  it('using a template opens the composer with a server preview; Save as template pre-fills the editor; send uses only template/subject/body', async () => {
    api.sendParentEmail.mockResolvedValue({ status: 'SENT' });
    mount(); await settle();
    await click(button(/Session reminder/, composer().querySelector('[aria-label="Saved templates"]')));
    expect(composer().querySelector('[aria-current="step"]').textContent).toContain('Write');
    expect(composer().querySelector('.rx-pe__tag').textContent).toBe('Saved template');
    const textarea = composer().querySelector('textarea');
    expect(textarea.value).toBe('Hello {{parentFirstName}}');
    await click(button(/Child first name/, composer()));
    expect(textarea.value).toBe('Hello {{parentFirstName}}{{childFirstName}}');
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); }); await settle();
    expect(api.previewParentEmail).toHaveBeenCalled();
    expect(composer().querySelector('[aria-label="Live preview"]').textContent).toContain('To: Sarah Khan <sarah@example.com>');

    await click(button(/^Save as template$/, composer()));
    expect(top().textContent).toContain('Create Template');
    expect(document.getElementById('et-name').value).toBe('');
    expect(document.getElementById('et-body').value).toBe('Hello {{parentFirstName}}{{childFirstName}}');
    await click(button(/^Cancel$/, top()));
    await click(button(/^Discard$/, top()));
    expect(dialogs()).toHaveLength(1);

    await click(button(/^Review & send$/, composer()));
    expect(composer().querySelector('.rx-pe__review-rows').textContent).toContain('sarah@example.com');
    await click(button(/^Send email$/, composer()));
    expect(api.sendParentEmail).toHaveBeenCalledWith('c-1', { templateId: 't-1', subject: 'Reminder for {{childFirstName}}', body: 'Hello {{parentFirstName}}{{childFirstName}}' });
    expect(onClose).toHaveBeenCalled();
  });
});
