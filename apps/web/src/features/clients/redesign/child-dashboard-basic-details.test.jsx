import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Spec Changes 1/4/6/7 — the Company Child Dashboard overview:
 *   - Basic Details show Child + Parent (name/mobile/email) + Address.
 *   - DOB renders MM/DD/YYYY (timezone-safe, from a stored YYYY-MM-DD).
 *   - Progress / Sessions / Plans are NOT standalone dashboard tabs.
 * Any React act() warning fails the test (Part 28 / Change 17).
 */

const CHILD = {
  client: {
    id: 'c-1', firstName: 'john', lastName: 'smith', clientNumber: 'CL-9', status: 'ACTIVE',
    dateOfBirth: '2015-08-27', version: 3, intakeWorkflowStatus: 'RECEIVED',
    address: { line1: '123 Main Street', line2: 'Apt 2', city: 'Austin', state: 'TX', postalCode: '78701' },
  },
  guardians: [
    { id: 'g-1', firstName: 'jane', lastName: 'smith', relationship: 'PARENT', isPrimary: true, phone: '+1 555 123 4567', email: 'jane@example.com' },
  ],
  careTeam: [], contacts: [], serviceAuthorizations: [],
};

vi.mock('@/api/client', () => ({
  getClient: vi.fn(async () => CHILD),
  transitionIntakeStatus: vi.fn(),
  updateClient: vi.fn(),
  fetchChildAlerts: vi.fn(async () => ({ alerts: [], summary: {} })),
}));

vi.mock('@/auth/store', () => ({
  useAuthStore: (selector) => selector({ principal: { roles: ['owner'], permissions: ['clients.update'] } }),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

let ClientDetailRedesign;
beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ ClientDetailRedesign } = await import('./ClientDetailRedesign.jsx'));
});

let host; let root;
const mount = () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/clients/c-1']}>
            <Routes><Route path="/clients/:clientId" element={<ClientDetailRedesign />} /></Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
};
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = undefined; host = undefined;
  const warnings = actWarnings();
  consoleErrorSpy.mockRestore();
  expect(warnings, `act() warnings: ${JSON.stringify(warnings)}`).toHaveLength(0);
});

const waitFor = async (re) => {
  for (let i = 0; i < 60; i += 1) {
    if (re.test(host.textContent)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  throw new Error(`text ${re} never appeared. Got: ${host.textContent.slice(0, 500)}`);
};
const tabLabels = () => [...host.querySelectorAll('button, a, [role="tab"]')].map((el) => el.textContent);

describe('Company Child Dashboard — Basic Details & cleanup', () => {
  it('shows Child name (properly cased) and DOB in MM/DD/YYYY', async () => {
    mount();
    await waitFor(/John Smith/); // formatFullName title-cases "john smith"
    expect(host.textContent).toMatch(/John Smith/);
    expect(host.textContent).toMatch(/08\/27\/2015/); // MM/DD/YYYY, timezone-safe
    expect(host.textContent).not.toMatch(/2015-08-27/); // never the raw ISO form
    expect(host.textContent).not.toMatch(/27\/08\/2015/); // never DD/MM/YYYY
  });

  it('shows Parent name, mobile and email', async () => {
    mount();
    await waitFor(/Jane Smith/);
    expect(host.textContent).toMatch(/Jane Smith/);
    expect(host.textContent).toMatch(/\+1 555 123 4567/);
    expect(host.textContent).toMatch(/jane@example\.com/);
  });

  it('shows the structured Address', async () => {
    mount();
    await waitFor(/123 Main Street/);
    expect(host.textContent).toMatch(/123 Main Street/);
    expect(host.textContent).toMatch(/Austin/);
    expect(host.textContent).toMatch(/TX/);
    expect(host.textContent).toMatch(/78701/);
  });

  it('does NOT present Progress, Sessions or Plans as standalone dashboard tabs', async () => {
    mount();
    await waitFor(/John Smith/);
    const labels = tabLabels();
    expect(labels.some((t) => /^Progress$/.test(t))).toBe(false);
    expect(labels.some((t) => /^Sessions$/.test(t))).toBe(false);
    expect(labels.some((t) => /^Plans$/.test(t) || /^Treatment plan$/.test(t))).toBe(false);
    // The sections that SHOULD remain are still present.
    expect(labels.some((t) => /Medical/.test(t))).toBe(true);
    expect(labels.some((t) => /Insurance/.test(t))).toBe(true);
    expect(labels.some((t) => /Authorizations/.test(t))).toBe(true);
    expect(labels.some((t) => /Care team/.test(t))).toBe(true);
  });

  it('does not leak internal IDs (tenantId) into the overview', async () => {
    mount();
    await waitFor(/John Smith/);
    expect(host.textContent).not.toMatch(/tenantId/i);
  });
});
