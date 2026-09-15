import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Spec Module 6 Part 21 — switching the Child in the booking modal MUST clear the
 * previously selected authorization and load the NEW child's authorizations. A
 * child-A authorization must never linger when child B is chosen. act()-clean.
 */
const listAuthorizations = vi.fn();
const listCareTeam = vi.fn();
vi.mock('@/api/client', async (orig) => ({
  ...(await orig()),
  listAuthorizations: (...a) => listAuthorizations(...a),
  listCareTeam: (...a) => listCareTeam(...a),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let BookingModal;

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ BookingModal } = await import('./SchedulingRedesign.jsx'));
  listAuthorizations.mockReset(); listCareTeam.mockReset();
  listCareTeam.mockResolvedValue([{ id: 'asg-1', staffProfileId: 'staff-1', role: 'BCBA', status: 'ACTIVE', staffName: 'Lee, Jordan', effectiveStartDate: '2026-01-01', effectiveEndDate: null }]);
  // Per-child authorizations: child-1 has ABA-001, child-2 has FBA-002.
  listAuthorizations.mockImplementation(({ clientId } = {}) => Promise.resolve({
    items: clientId === 'child-2'
      ? [{ id: 'auth-fba', authorizationNumber: 'FBA-002', serviceCode: 'FBA', status: 'APPROVED', authorizedUnits: 80, remainingUnits: 80, startDate: '2026-01-01', endDate: '2026-12-31' }]
      : clientId === 'child-1'
        ? [{ id: 'auth-aba', authorizationNumber: 'ABA-001', serviceCode: 'ABA', status: 'APPROVED', authorizedUnits: 160, remainingUnits: 120, startDate: '2026-01-01', endDate: '2026-12-31' }]
        : [],
  }));
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const clientOpts = [{ value: 'child-1', label: 'Alex R.' }, { value: 'child-2', label: 'Sam T.' }];
const staffOpts = [{ value: 'staff-1', label: 'Jordan Lee' }];

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <BookingModal open onClose={vi.fn()} clientOpts={clientOpts} staffOpts={staffOpts} onBook={vi.fn()} />
    </ToastProvider></QueryClientProvider>,
  ));
};
const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const qa = (sel) => [...document.querySelectorAll(sel)];
const selectByLabel = async (labelText, optionRe) => {
  const field = qa('.rx-formfield').find((f) => f.textContent.includes(labelText));
  const trigger = field.querySelector('.rx-select__trigger');
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  const opt = qa('.rx-select__opt').find((o) => optionRe.test(o.textContent));
  await act(async () => { opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const authBoxes = () => qa('input[type="checkbox"]');
const authBox = (re) => authBoxes().find((c) => re.test(c.getAttribute('aria-label') || ''));

describe('BookingModal — child switch (Part 21)', () => {
  it('clears the chosen authorization and loads the new child’s authorizations', async () => {
    mount();
    await selectByLabel('Client', /Alex R\./);
    await flush();
    // check child A's ABA-001 authorization
    await act(async () => { authBox(/ABA-001/).dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    expect(authBox(/ABA-001/).checked).toBe(true);

    // switch to child B
    await selectByLabel('Client', /Sam T\./);
    await flush();

    // the ABA-001 checkbox must be gone (child B has a different authorization set)
    expect(authBox(/ABA-001/)).toBeUndefined();
    // child B's authorizations were loaded (query called for child-2)
    expect(listAuthorizations.mock.calls.some(([a]) => a?.clientId === 'child-2')).toBe(true);
  });
});
