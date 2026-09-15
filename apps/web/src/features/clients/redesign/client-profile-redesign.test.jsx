import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Company Client Profile redesign:
 *   - the hero keeps Account status, Referral stage and Intake as SEPARATE badges,
 *     every value read from getClient (Account from the server's accountStatus);
 *   - editing/emailing is gated on clients.update;
 *   - Email Templates → Use Template (?compose=<id>) opens the existing composer
 *     with that saved template, next to the built-in catalog.
 * Any React act() warning fails the test.
 */
const CHILD = {
  client: {
    id: 'c-1', firstName: 'mia', lastName: 'khan', clientNumber: 'CL-0007', status: 'REFERRED', accountStatus: 'HOLD',
    dateOfBirth: '2019-04-02', version: 2, intakeWorkflowStatus: 'SENT', approvedWeeklyHours: 20,
  },
  guardians: [],
  careTeam: [{ id: 'a-1', role: 'BCBA', status: 'ACTIVE', staffName: 'Lovelace, Ada' }],
  contacts: [],
  serviceAuthorizations: [{ id: 'sa-1', serviceType: 'FBA', status: 'APPROVED' }],
};
const SAVED = { id: 'tpl-saved', name: 'Session reminder', subject: 'Reminder for {{childFirstName}}', body: 'Hello {{parentFirstName}}', version: 1 };
const BUILT_IN = { id: 'welcome', name: 'Welcome to services', category: 'Onboarding', description: 'First message', subject: 'Welcome', body: 'Hi', supportedVariables: ['childFirstName'] };

const api = vi.hoisted(() => ({
  getClient: vi.fn(), fetchChildAlerts: vi.fn(), listEmailTemplates: vi.fn(), fetchParentEmailTemplates: vi.fn(), previewParentEmail: vi.fn(),
}));
vi.mock('@/api/client', () => ({
  getClient: (...a) => api.getClient(...a),
  fetchChildAlerts: (...a) => api.fetchChildAlerts(...a),
  listEmailTemplates: (...a) => api.listEmailTemplates(...a),
  fetchParentEmailTemplates: (...a) => api.fetchParentEmailTemplates(...a),
  previewParentEmail: (...a) => api.previewParentEmail(...a),
  sendParentEmail: vi.fn(), transitionIntakeStatus: vi.fn(), updateClient: vi.fn(),
}));
let permissions = ['clients.read', 'clients.update'];
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ principal: { roles: ['owner'], permissions } }),
}));

let consoleErrorSpy; let ClientDetailRedesign; let host; let root; let lastLocation;
function Probe() { lastLocation = useLocation(); return null; }

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  permissions = ['clients.read', 'clients.update'];
  api.getClient.mockResolvedValue(CHILD);
  api.fetchChildAlerts.mockResolvedValue({ alerts: [], summary: {} });
  api.listEmailTemplates.mockResolvedValue({ items: [SAVED], supportedVariables: ['childFirstName', 'parentFirstName'] });
  api.fetchParentEmailTemplates.mockResolvedValue([BUILT_IN]);
  api.previewParentEmail.mockResolvedValue({ subject: 'Reminder for Mia', bodyText: 'Hello Sarah', recipient: { available: true, name: 'Sarah', email: 'sarah@example.com' }, sender: { name: 'Acme ABA' } });
  ({ ClientDetailRedesign } = await import('./ClientDetailRedesign.jsx'));
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove(); document.body.innerHTML = '';
  root = undefined; host = undefined;
  const warnings = consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
  consoleErrorSpy.mockRestore();
  expect(warnings).toHaveLength(0);
});

const mount = (url = '/clients/c-1') => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <MemoryRouter initialEntries={[url]}>
        <Probe />
        <Routes><Route path="/clients/:clientId" element={<ClientDetailRedesign />} /></Routes>
      </MemoryRouter>
    </ToastProvider></QueryClientProvider>,
  ));
};
const settle = async (n = 40) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent.trim());

describe('Client profile — hero', () => {
  it('shows real identity and keeps Account, Stage and Intake as separate statuses', async () => {
    mount(); await settle();
    expect(host.querySelector('.rx-cd__name').textContent).toBe('Mia Khan');
    expect(host.querySelector('.rx-cd__ids').textContent).toBe('Client #CL-0007Born 04/02/2019');
    expect(host.querySelector('.rx-cd__hero').className).toContain('rx-cd__hero--hold');
    const groups = [...host.querySelectorAll('.rx-cd__badge-group')].map((g) => g.textContent);
    expect(groups).toEqual(['AccountHold', 'StageReferred', 'IntakeSent']);
    const facts = host.querySelector('.rx-cd__facts').textContent;
    expect(facts).toContain('Ada Lovelace');
    expect(facts).toContain('Not assigned'); // no RBT on the care team
    expect(facts).toContain('Approved · Not sent');
    expect(facts).toContain('20 hrs/week');
    expect(buttons()).toEqual(expect.arrayContaining(['Edit Client', 'Send email', 'Schedule']));
  });

  it('without clients.update there is no Edit Client or Send email, and ?compose is ignored', async () => {
    permissions = ['clients.read'];
    mount('/clients/c-1?compose=tpl-saved'); await settle();
    expect(buttons()).not.toContain('Edit Client');
    expect(buttons()).not.toContain('Send email');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.listEmailTemplates).not.toHaveBeenCalled();
  });

  it('a client that is not available shows Client not found (no data leaked)', async () => {
    api.getClient.mockRejectedValue({ response: { status: 404 } });
    mount(); await settle();
    expect(host.textContent).toContain('Client not found');
    expect(host.querySelector('.rx-cd__hero')).toBeNull();
  });
});

describe('Client profile — saved email templates', () => {
  it('Send email lists saved templates alongside the built-in catalog', async () => {
    mount(); await settle();
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send email').click(); });
    await settle();
    const dlg = document.querySelector('[role="dialog"]');
    expect(dlg.querySelector('[aria-label="Saved templates"]').textContent).toContain('Session reminder');
    expect(dlg.querySelector('[aria-label="Built-in templates"]').textContent).toContain('Welcome to services');
  });

  it('?compose=<saved template> opens the composer on that template, previews via the server and clears the URL', async () => {
    mount('/clients/c-1?compose=tpl-saved'); await settle(80);
    const dlg = document.querySelector('[role="dialog"]');
    expect(dlg.textContent).toContain('Session reminder');
    expect(dlg.querySelector('input').value).toBe('Reminder for {{childFirstName}}');
    expect(dlg.querySelector('textarea').value).toBe('Hello {{parentFirstName}}');
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    await settle();
    expect(api.previewParentEmail).toHaveBeenCalledWith('c-1', expect.objectContaining({ templateId: 'tpl-saved' }));
    expect(lastLocation.search).toBe('');
  });
});
