import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * ADD = SAVE for FBA / ABA / Insurance on the child dashboard.
 *   - The Add action calls the existing create endpoint once and the saved record
 *     is shown straight away (even before the list refetch returns).
 *   - No "Mark sent" / "Approve" / "Verify" call is made to save it; a new
 *     authorization shows as Saved + "Not sent" and a new coverage as Saved +
 *     unverified — saving is never shown as approval.
 *   - The payer review (Mark sent → Review & approve) is still offered and works.
 *   - Everything derived from the record is invalidated (client, roster, alerts).
 * Any React act() warning fails the test.
 */
const api = vi.hoisted(() => ({
  listServiceAuthorizations: vi.fn(), createServiceAuthorization: vi.fn(), updateServiceAuthorization: vi.fn(), transitionServiceAuthorization: vi.fn(), archiveServiceAuthorization: vi.fn(),
  fetchCoverage: vi.fn(), createCoverage: vi.fn(), updateCoverage: vi.fn(), removeCoverage: vi.fn(), verifyCoverage: vi.fn(), listInsuranceCatalog: vi.fn(),
}));
vi.mock('@/api/client', () => Object.fromEntries(Object.keys(api).map((k) => [k, (...a) => api[k](...a)])));
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { permissions: ['clients.read', 'clients.update'] } }) }));

let consoleErrorSpy; let host; let root; let qc; let AuthorizationsPanel; let InsurancePanelRedesign;
const never = () => new Promise(() => {});

beforeEach(async () => {
  ({ AuthorizationsPanel } = await import('./AuthorizationsPanel.jsx'));
  ({ InsurancePanelRedesign } = await import('./InsurancePanelRedesign.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove(); document.body.innerHTML = '';
  root = undefined; host = undefined;
  const w = consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
  consoleErrorSpy.mockRestore();
  expect(w).toHaveLength(0);
});

const mount = (ui) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(qc, 'invalidateQueries');
  act(() => root.render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>));
};
const settle = async (n = 30) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const buttons = (re, scope = document) => [...scope.querySelectorAll('button')].filter((b) => re.test(b.textContent.trim()));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); };
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1);
const setInput = async (el, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const fieldInput = (label) => [...dialog().querySelectorAll('.rx-formfield')].find((f) => f.querySelector('label')?.textContent.startsWith(label))?.querySelector('input');
const invalidated = () => qc.invalidateQueries.mock.calls.map(([f]) => JSON.stringify(f.queryKey));

describe.each(['ABA', 'FBA'])('Add %s authorization', (type) => {
  it('saves immediately through the create API and shows the record as Saved · Not sent — no review step needed', async () => {
    const saved = { id: `sa-${type}`, serviceType: type, status: 'NOT_SENT', authorizationNumber: `${type}-77`, units: 40, usedUnits: 0, remainingUnits: 40, hours: 10, startDate: '2026-09-14', endDate: null, history: [] };
    api.listServiceAuthorizations.mockResolvedValueOnce([]).mockImplementation(never); // the refetch never returns: the UI must not depend on it
    api.createServiceAuthorization.mockResolvedValue(saved);
    mount(<AuthorizationsPanel clientId="c-1" />); await settle();

    await click(buttons(new RegExp(`^Add ${type}$`))[0]);
    expect(dialog().textContent).toContain(`Add ${type} authorization`);
    expect(dialog().textContent).toContain('Adding saves the authorization immediately');
    await setInput(fieldInput('Authorization number'), `${type}-77`);
    await setInput(fieldInput('Units'), '40');
    await click(buttons(/^Add authorization$/, dialog())[0]);

    expect(api.createServiceAuthorization).toHaveBeenCalledTimes(1);
    const [clientId, body] = api.createServiceAuthorization.mock.calls[0];
    expect(clientId).toBe('c-1');
    expect(body).toMatchObject({ serviceType: type, authorizationNumber: `${type}-77`, units: 40 });
    expect(body).not.toHaveProperty('status');
    expect(api.transitionServiceAuthorization).not.toHaveBeenCalled();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain(`#${type}-77`);
    expect(host.textContent).toContain('Saved');
    expect(host.textContent).toContain('Not sent');
    expect(host.textContent).not.toMatch(/Approved/);
    expect(document.body.textContent).toContain(`${type} authorization added and saved.`);
    expect(invalidated()).toEqual(expect.arrayContaining(['["authorizations","c-1"]', '["client","c-1"]', '["clients"]', '["child-alerts","c-1"]']));
  });
});

describe('payer review is still available after saving', () => {
  it('Mark sent and Review & approve remain separate transitions', async () => {
    const auth = { id: 'sa-1', serviceType: 'ABA', status: 'NOT_SENT', authorizationNumber: 'A-1', history: [] };
    api.listServiceAuthorizations.mockResolvedValue([auth]);
    api.transitionServiceAuthorization.mockResolvedValue({ ...auth, status: 'SENT', history: [{ from: 'NOT_SENT', to: 'SENT' }] });
    mount(<AuthorizationsPanel clientId="c-1" />); await settle();
    expect(host.querySelector('[aria-label="Payer review"]').textContent).toContain('Payer review (optional)');
    expect(buttons(/^Review & approve$/)).toHaveLength(0); // approve is only offered once sent
    await click(buttons(/^Mark sent$/)[0]);
    await click(buttons(/^Mark sent$/, dialog())[0]);
    expect(api.transitionServiceAuthorization).toHaveBeenCalledWith('c-1', 'sa-1', 'SENT', undefined);
  });
});

describe('Add insurance', () => {
  it('saves immediately and is active (verified by the server) — no separate verification call', async () => {
    const saved = { id: 'cov-1', payerName: 'Acme Health', memberId: 'M-999', verificationStatus: 'VERIFIED', catalogInsuranceId: null };
    api.fetchCoverage.mockResolvedValueOnce({ items: [], status: null }).mockImplementation(never);
    api.listInsuranceCatalog.mockResolvedValue([]);
    api.createCoverage.mockResolvedValue(saved);
    mount(<InsurancePanelRedesign clientId="c-1" />); await settle();

    await click(buttons(/^Add insurance$/)[0]);
    expect(dialog().textContent).toContain('Adding saves the insurance and makes it active immediately.');
    const inputs = [...dialog().querySelectorAll('input')];
    await setInput(inputs[0], 'Acme Health');
    await setInput(inputs[1], 'M-999');
    await click(buttons(/^Add insurance$/, dialog()).at(-1));

    expect(api.createCoverage).toHaveBeenCalledTimes(1);
    expect(api.createCoverage.mock.calls[0][1]).not.toHaveProperty('verificationStatus');
    expect(api.verifyCoverage).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Acme Health');
    expect(host.textContent).toContain('Member M-999');
    expect(host.textContent).toContain('Saved');
    expect(host.textContent).toContain('verified');
    expect(host.textContent).not.toContain('unverified');
    expect(buttons(/^Verify$/)).toHaveLength(0);
    expect(document.body.textContent).toContain('Insurance added and saved.');
    expect(invalidated()).toEqual(expect.arrayContaining(['["coverage","c-1"]', '["client","c-1"]', '["clients"]', '["child-alerts","c-1"]']));
  });
});
