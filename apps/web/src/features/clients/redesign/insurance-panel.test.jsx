import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Spec Module 5.4/5.5/5.6 — the client Insurance panel:
 *   - catalog picker filtered to the company (name + state) with an "Other
 *     insurance" free-text fallback;
 *   - when coverage exists, each record offers Edit and Delete (not just Add);
 *   - empty state offers Add.
 * Any React act() warning fails the test.
 */
const fetchCoverage = vi.fn();
const createCoverage = vi.fn();
const updateCoverage = vi.fn();
const removeCoverage = vi.fn();
const verifyCoverage = vi.fn();
const listInsuranceCatalog = vi.fn();

vi.mock('@/api/client', () => ({
  fetchCoverage: (...a) => fetchCoverage(...a),
  createCoverage: (...a) => createCoverage(...a),
  updateCoverage: (...a) => updateCoverage(...a),
  removeCoverage: (...a) => removeCoverage(...a),
  verifyCoverage: (...a) => verifyCoverage(...a),
  listInsuranceCatalog: (...a) => listInsuranceCatalog(...a),
}));

let perms = ['clients.update'];
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { permissions: perms } }) }));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

let host; let root; let InsurancePanelRedesign;
beforeEach(async () => {
  ({ InsurancePanelRedesign } = await import('./InsurancePanelRedesign.jsx'));
  consoleErrorSpy = vi.spyOn(console, 'error');
  fetchCoverage.mockReset(); createCoverage.mockReset(); updateCoverage.mockReset(); removeCoverage.mockReset(); verifyCoverage.mockReset(); listInsuranceCatalog.mockReset();
  listInsuranceCatalog.mockResolvedValue([
    { id: 'ic-1', name: 'CA Health', states: ['CA'], logoUrl: null, active: true },
    { id: 'ic-2', name: 'Golden State PPO', states: ['CA'], logoUrl: null, active: true },
  ]);
  perms = ['clients.update'];
});
afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = undefined; host = undefined;
  const w = actWarnings();
  consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}><ToastProvider><InsurancePanelRedesign clientId="c-1" /></ToastProvider></QueryClientProvider>,
    );
  });
};
const waitFor = async (re, where = () => host.textContent) => {
  for (let i = 0; i < 80; i += 1) { if (re.test(where())) return; await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
  throw new Error(`text ${re} never appeared`);
};
const btnByText = (re, rootEl = document) => [...rootEl.querySelectorAll('button')].find((b) => re.test(b.textContent));
const click = async (el) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); }); };

describe('InsurancePanelRedesign — Module 5', () => {
  it('empty state offers Add insurance', async () => {
    fetchCoverage.mockResolvedValue({ items: [], status: null });
    mount();
    await waitFor(/No insurance recorded/);
    expect(btnByText(/Add insurance/)).toBeTruthy();
  });

  it('add flow shows a catalog picker and an "Other insurance" fallback toggle', async () => {
    fetchCoverage.mockResolvedValue({ items: [], status: null });
    mount();
    await waitFor(/No insurance recorded/);
    await click(btnByText(/Add insurance/));
    await waitFor(/Insurance company/, () => document.body.textContent);
    // catalog select present (custom Select trigger)
    expect(document.querySelector('.rx-select__trigger')).toBeTruthy();
    // Other insurance toggle present
    const other = btnByText(/Add other insurance/);
    expect(other).toBeTruthy();
    await click(other);
    // now a free-text insurer input is shown
    await waitFor(/Insurance company \(other\)/, () => document.body.textContent);
  });

  it('Fix 2 — the Add/Edit form does NOT show Plan Name, Benefit Order or Funding Source', async () => {
    fetchCoverage.mockResolvedValue({ items: [], status: null });
    mount();
    await waitFor(/No insurance recorded/);
    await click(btnByText(/Add insurance/));
    await waitFor(/Insurance company/, () => document.body.textContent);
    const body = document.body.textContent;
    expect(body).not.toMatch(/Plan name/i);
    expect(body).not.toMatch(/Benefit order/i);
    expect(body).not.toMatch(/Funding source/i);
    // The fields that DO remain are still present.
    expect(body).toMatch(/Member ID/);
  });

  it('Fix 2 — create payload omits planName, benefitOrder and fundingSource', async () => {
    fetchCoverage.mockResolvedValue({ items: [], status: null });
    createCoverage.mockResolvedValue({ id: 'cov-1' });
    listInsuranceCatalog.mockResolvedValue([]); // force "Other insurance" free-text path
    mount();
    await waitFor(/No insurance recorded/);
    await click(btnByText(/Add insurance/));
    // Wait until the catalog query has resolved empty and the free-text payer
    // field (the only path when there is no catalog) is shown.
    await waitFor(/Insurance company \(other\)/, () => document.body.textContent);
    const inputs = [...document.querySelectorAll('input')];
    const setVal = (el, v) => { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    await act(async () => {
      setVal(inputs[0], 'Acme Health'); // payer (other)
      setVal(inputs[1], 'M-999');       // member ID
      await Promise.resolve();
    });
    // Click the modal FOOTER "Add insurance" (the last such button), not the
    // empty-state one behind the drawer.
    const addButtons = [...document.querySelectorAll('button')].filter((b) => /^Add insurance$/.test(b.textContent));
    await click(addButtons[addButtons.length - 1]);
    for (let i = 0; i < 80 && createCoverage.mock.calls.length === 0; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(createCoverage.mock.calls.length).toBeGreaterThan(0);
    const [, sentBody] = createCoverage.mock.calls[0];
    expect(sentBody).not.toHaveProperty('planName');
    expect(sentBody).not.toHaveProperty('benefitOrder');
    expect(sentBody).not.toHaveProperty('fundingSource');
    expect(sentBody.payerName).toBe('Acme Health');
    expect(sentBody.memberId).toBe('M-999');
  });

  it('Fix 2 — the catalog logo is displayed on a saved coverage record when present', async () => {
    fetchCoverage.mockResolvedValue({ items: [
      { id: 'cov-1', payerName: 'CA Health', catalogInsuranceId: 'ic-1', memberId: 'M1', logoUrl: 'https://cdn/ca.png', verificationStatus: 'UNVERIFIED' },
    ], status: null });
    mount();
    await waitFor(/CA Health/);
    const logo = [...host.querySelectorAll('img')].find((img) => img.getAttribute('src') === 'https://cdn/ca.png');
    expect(logo).toBeTruthy();
  });

  it('existing coverage shows Edit and Delete actions (not only Add)', async () => {
    fetchCoverage.mockResolvedValue({ items: [
      { id: 'cov-1', payerName: 'CA Health', catalogInsuranceId: 'ic-1', memberId: 'M1', benefitOrder: 'PRIMARY', verificationStatus: 'UNVERIFIED' },
    ], status: null });
    mount();
    await waitFor(/CA Health/);
    expect(document.querySelector('button[aria-label="Edit insurance"]')).toBeTruthy();
    expect(document.querySelector('button[aria-label="Delete insurance"]')).toBeTruthy();
    // single-insurance rule: NO Add button once one insurance exists
    expect(host.textContent).not.toMatch(/Add another/);
    expect(btnByText(/Add insurance/)).toBeFalsy();
  });

  // --- Bug #2: insurance EDIT must persist to the SAME record ---------------
  // Helper: set a controlled input's value the React way.
  const setInput = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  // A record whose optional fields are null — the shape the API returns and the
  // exact input that used to crash the editor on Save (`null.trim()`).
  const nullFieldRecord = {
    id: 'cov-1', payerName: 'Acme Health', catalogInsuranceId: null, memberId: 'M1',
    groupNumber: null, subscriberName: null, subscriberRelationship: 'PARENT',
    verificationStatus: 'UNVERIFIED', verificationHistory: [],
  };

  it('Bug #2 — editing a record with null optional fields does not crash and calls updateCoverage with the SAME id', async () => {
    fetchCoverage.mockResolvedValue({ items: [nullFieldRecord], status: null });
    updateCoverage.mockResolvedValue({ ...nullFieldRecord, memberId: 'M2' });
    mount();
    await waitFor(/Acme Health/);
    await click(document.querySelector('button[aria-label="Edit insurance"]'));
    await waitFor(/Edit insurance/, () => document.body.textContent);
    const memberInput = [...document.querySelectorAll('input')].find((i) => i.value === 'M1');
    expect(memberInput, 'the existing member id must load into the form').toBeTruthy();
    await act(async () => { setInput(memberInput, 'M2'); await Promise.resolve(); });
    await click(btnByText(/Save changes/));
    for (let i = 0; i < 80 && updateCoverage.mock.calls.length === 0; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    // The update request actually fired (it used to throw before reaching here),
    // targeting the SAME client + coverage id — never a create, never a new record.
    expect(updateCoverage.mock.calls.length, 'updateCoverage must be called').toBeGreaterThan(0);
    expect(createCoverage).not.toHaveBeenCalled();
    const [cid, covId, body] = updateCoverage.mock.calls[0];
    expect(cid).toBe('c-1');
    expect(covId).toBe('cov-1');
    expect(body.memberId).toBe('M2');
  });

  it('Bug #2 — an emptied optional field is sent as null so the clear persists', async () => {
    const withGroup = { ...nullFieldRecord, groupNumber: 'G-77' };
    fetchCoverage.mockResolvedValue({ items: [withGroup], status: null });
    updateCoverage.mockResolvedValue({ ...withGroup, groupNumber: null });
    mount();
    await waitFor(/Acme Health/);
    await click(document.querySelector('button[aria-label="Edit insurance"]'));
    await waitFor(/Edit insurance/, () => document.body.textContent);
    const groupInput = [...document.querySelectorAll('input')].find((i) => i.value === 'G-77');
    expect(groupInput).toBeTruthy();
    await act(async () => { setInput(groupInput, ''); await Promise.resolve(); });
    await click(btnByText(/Save changes/));
    for (let i = 0; i < 80 && updateCoverage.mock.calls.length === 0; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(updateCoverage.mock.calls.length).toBeGreaterThan(0);
    const [, , body] = updateCoverage.mock.calls[0];
    expect(body.groupNumber).toBe(null);
  });

  it('Bug #2 — after a successful edit the coverage query is refetched (new value shown, not stale)', async () => {
    // First load returns M1; after the edit resolves, the invalidated query
    // refetches and returns M2 — proving the panel shows persisted state, not
    // local form state (spec Part 23 "updated value visible / survives refetch").
    fetchCoverage
      .mockResolvedValueOnce({ items: [nullFieldRecord], status: null })
      .mockResolvedValue({ items: [{ ...nullFieldRecord, memberId: 'M2' }], status: null });
    updateCoverage.mockResolvedValue({ ...nullFieldRecord, memberId: 'M2' });
    mount();
    await waitFor(/Member M1/);
    await click(document.querySelector('button[aria-label="Edit insurance"]'));
    await waitFor(/Edit insurance/, () => document.body.textContent);
    const memberInput = [...document.querySelectorAll('input')].find((i) => i.value === 'M1');
    await act(async () => { setInput(memberInput, 'M2'); await Promise.resolve(); });
    await click(btnByText(/Save changes/));
    await waitFor(/Member M2/);
    expect(fetchCoverage.mock.calls.length).toBeGreaterThan(1); // initial + refetch
    expect(host.textContent).toMatch(/Member M2/);
    expect(host.textContent).not.toMatch(/Member M1/);
  });

  it('delete asks for confirmation then calls removeCoverage', async () => {
    fetchCoverage.mockResolvedValue({ items: [
      { id: 'cov-1', payerName: 'CA Health', catalogInsuranceId: 'ic-1', memberId: 'M1', benefitOrder: 'PRIMARY', verificationStatus: 'UNVERIFIED' },
    ], status: null });
    removeCoverage.mockResolvedValue({ id: 'cov-1', deleted: true });
    mount();
    await waitFor(/CA Health/);
    await click(document.querySelector('button[aria-label="Delete insurance"]'));
    await waitFor(/Remove insurance\?/, () => document.body.textContent);
    await click(btnByText(/^Remove$/, document));
    expect(removeCoverage).toHaveBeenCalledWith('c-1', 'cov-1');
  });
});
