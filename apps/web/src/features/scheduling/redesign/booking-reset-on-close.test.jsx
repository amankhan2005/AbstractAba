import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * BookingModal — reset on close (spec §12 "reset the modal appropriately" / §23
 * "initial state empty").
 *
 * The modal is ALWAYS mounted (visibility driven by `open`), so without an
 * explicit reset its field state would persist across opens — reopening "New
 * appointment" after a booking would show the previous child's selections. This
 * test drives the real component: it selects a child (which loads the mocked
 * care team + authorizations), closes the modal, reopens it, and asserts the
 * child selector is back to its placeholder rather than the previous value.
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
  listCareTeam.mockResolvedValue([{ id: 'asg-1', staffProfileId: 'staff-1', role: 'BCBA', status: 'ACTIVE', staffName: 'Lee, Jordan' }]);
  listAuthorizations.mockResolvedValue({ items: [
    { id: 'auth-aba', authorizationNumber: 'ABA-001', serviceCode: 'ABA', status: 'APPROVED', authorizedUnits: 160, remainingUnits: 120, startDate: '2026-01-01', endDate: '2026-12-31' },
  ] });
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const clientOpts = [{ value: 'child-1', label: 'Alex R.' }];
const staffOpts = [{ value: 'staff-1', label: 'Jordan Lee' }];
const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function render(open) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}><ToastProvider>
      <BookingModal open={open} onClose={() => {}} clientOpts={clientOpts} staffOpts={staffOpts} onBook={vi.fn()} />
    </ToastProvider></QueryClientProvider>
  );
}

describe('BookingModal — reset on close', () => {
  it('clears the selected child when the modal closes, so reopening starts clean', async () => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    act(() => root.render(render(true)));
    await flush();

    // Select the child via the child <Select> (first combobox in the drawer).
    const combo = document.querySelector('[role="combobox"], .rx-select__control, button');
    // Fall back to clicking the labelled control: open the child select and choose the option.
    const childControl = Array.from(document.querySelectorAll('button')).find((b) => /select a client/i.test(b.textContent || ''));
    act(() => (childControl || combo)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    act(() => (childControl || combo)?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const opt = Array.from(document.querySelectorAll('*')).find((n) => n.childElementCount === 0 && /Alex R\./.test(n.textContent || ''));
    if (opt) act(() => opt.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    // The care-team query for the chosen child should have fired.
    expect(listCareTeam).toHaveBeenCalledWith('child-1');

    // Close the modal.
    act(() => root.render(render(false)));
    await flush();
    // Reopen it.
    act(() => root.render(render(true)));
    await flush();

    // The child field is back to its placeholder — no stale "Alex R." selection.
    const text = document.body.textContent || '';
    expect(/Select a client/i.test(text)).toBe(true);
  });
});
