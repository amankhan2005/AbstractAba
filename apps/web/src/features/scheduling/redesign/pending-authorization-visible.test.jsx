import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * BUG #1 — a just-created ABA/FBA authorization must be VISIBLE and USABLE in
 * Scheduling. The server maps every saved, non-denied authorization to ACTIVE
 * (no review/approval step is required), so it is selectable immediately. Only
 * a DENIED authorization is unselectable; it surfaces as a hint and inline
 * creation stays available. act()-clean.
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
  listCareTeam.mockResolvedValue([]);
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
  vi.clearAllMocks();
});

const clientOpts = [{ value: 'child-1', label: 'Alex R.' }];
const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <BookingModal open onClose={vi.fn()} clientOpts={clientOpts} staffOpts={[]} onBook={vi.fn()} />
    </ToastProvider></QueryClientProvider>,
  ));
};
const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const qa = (sel) => [...document.querySelectorAll(sel)];
const selectChild = async (re) => {
  const field = qa('.rx-formfield').find((f) => f.textContent.includes('Client'));
  const trig = field.querySelector('.rx-select__trigger');
  await act(async () => { trig.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  const opt = qa('.rx-select__opt').find((o) => re.test(o.textContent));
  await act(async () => { opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  await flush();
};
const createBtn = () => qa('button').find((b) => /Create authorization/i.test(b.textContent));
// Authorizations render as a checkbox list; only usable (ACTIVE) rows appear.
const authLabels = () => qa('input[type="checkbox"]').map((c) => c.getAttribute('aria-label') || '');

describe('Scheduling — authorization usable as soon as it is added (BUG #1)', () => {
  it('a just-added authorization (server status ACTIVE, payer workflow NOT_SENT) is selectable at once — no approval hint', async () => {
    listAuthorizations.mockResolvedValue({ items: [
      { id: 'svc:sa-new', authorizationNumber: 'ABA-001', serviceCode: 'ABA', status: 'ACTIVE', workflowStatus: 'NOT_SENT', authorizedUnits: 160, remainingUnits: 160, startDate: '2026-01-01', endDate: '2026-12-31' },
    ] });
    mount();
    await flush();
    await selectChild(/Alex R\./);
    expect(authLabels().some((o) => /ABA-001/.test(o))).toBe(true);
    expect(document.body.textContent).not.toMatch(/pending approval|approve/i);
    expect(createBtn()).toBeUndefined();
  });

  it('a DENIED authorization is not selectable; the user is told and can add a new one', async () => {
    listAuthorizations.mockResolvedValue({ items: [
      { id: 'svc:sa-denied', authorizationNumber: 'ABA-DENIED', serviceCode: 'ABA', status: 'DENIED', workflowStatus: 'DENIED', authorizedUnits: 80, remainingUnits: 80, startDate: '2026-01-01', endDate: '2026-12-31' },
    ] });
    mount();
    await flush();
    await selectChild(/Alex R\./);
    expect(authLabels().some((o) => /ABA-DENIED/.test(o))).toBe(false);
    expect(document.body.textContent).toMatch(/denied — add a new authorization/i);
    expect(createBtn()).toBeTruthy();
  });

  it('with a mix, the usable authorization is selectable and the denied one is not', async () => {
    listAuthorizations.mockResolvedValue({ items: [
      { id: 'svc:sa-ok', authorizationNumber: 'ABA-OK', serviceCode: 'ABA', status: 'ACTIVE', workflowStatus: 'SENT', authorizedUnits: 160, remainingUnits: 120, startDate: '2026-01-01', endDate: '2026-12-31' },
      { id: 'svc:sa-denied', authorizationNumber: 'ABA-DENIED', serviceCode: 'ABA', status: 'DENIED', workflowStatus: 'DENIED', authorizedUnits: 80, remainingUnits: 80, startDate: '2026-01-01', endDate: '2026-12-31' },
    ] });
    mount();
    await flush();
    await selectChild(/Alex R\./);
    expect(createBtn()).toBeUndefined();
    const labels = authLabels();
    expect(labels.some((o) => /ABA-OK/.test(o))).toBe(true);
    expect(labels.some((o) => /ABA-DENIED/.test(o))).toBe(false);
  });

  it('offers inline creation when the child has no authorizations', async () => {
    listAuthorizations.mockResolvedValue({ items: [] });
    mount();
    await flush();
    await selectChild(/Alex R\./);
    expect(createBtn()).toBeTruthy();
  });
});
