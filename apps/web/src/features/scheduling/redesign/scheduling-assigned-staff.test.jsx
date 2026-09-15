import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components';

/**
 * Scheduling New Appointment — Staff comes ONLY from the selected child's CURRENT
 * care team (assigned BCBA/RBT), never the Company staff directory. Ended
 * assignments are excluded; missing roles show "No Assigned BCBA/RBT"; switching
 * child reloads the new child's team. Backend re-validates the same rule.
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
  listAuthorizations.mockResolvedValue({ items: [] });
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const clientOpts = [{ value: 'child-A', label: 'Alex R.' }, { value: 'child-B', label: 'Blair T.' }];
const staffOpts = [{ value: 'other-1', label: 'Directory Person' }];
const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}><ToastProvider>
      <BookingModal open onClose={vi.fn()} clientOpts={clientOpts} staffOpts={staffOpts} onBook={vi.fn()} />
    </ToastProvider></QueryClientProvider>,
  ));
};
const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const qa = (sel) => [...document.querySelectorAll(sel)];
const roleField = (label) => qa('.rx-formfield').find((f) => new RegExp(`^${label}`).test(f.textContent));
const openRole = async (label) => {
  const trig = roleField(label).querySelector('.rx-select__trigger');
  await act(async () => { trig.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const optionTexts = () => qa('.rx-select__opt').map((o) => o.textContent);
// Click the clinician-TYPE toggle (BCBA / RBT). One clinician per appointment
// (spec §4): the single clinician select reflects the chosen type.
const setType = async (role) => {
  const btn = qa('button').find((b) => b.textContent.trim() === role);
  await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};
const pickChild = async (re) => {
  const field = qa('.rx-formfield').find((f) => f.textContent.includes('Client'));
  const trig = field.querySelector('.rx-select__trigger');
  await act(async () => { trig.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
  const opt = qa('.rx-select__opt').find((o) => re.test(o.textContent));
  await act(async () => { opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};

describe('Scheduling assigned-staff filter', () => {
  it('shows ONLY the child\u2019s active assigned BCBA/RBT for the chosen type — not the company directory or ended assignments', async () => {
    listCareTeam.mockResolvedValue([
      { id: 'a1', staffProfileId: 'bcba-1', role: 'BCBA', status: 'ACTIVE', staffName: 'Johnson, Sarah' },
      { id: 'a2', staffProfileId: 'rbt-1', role: 'RBT', status: 'ACTIVE', staffName: 'Smith, Mike' },
      { id: 'a3', staffProfileId: 'rbt-old', role: 'RBT', status: 'ENDED', staffName: 'Former, Rob' },
    ]);
    mount(); await flush();
    await pickChild(/Alex R\./); await flush();
    // Default type is BCBA — the single select offers the child's active BCBA.
    await openRole('BCBA');
    let opts = optionTexts().join(' | ');
    expect(opts).toMatch(/Johnson, Sarah · BCBA/);
    expect(opts).not.toMatch(/Directory Person/);     // company directory excluded
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await Promise.resolve(); });
    // Switch the clinician TYPE to RBT — now the same single select offers the RBT.
    await setType('RBT');
    await openRole('RBT');
    opts = optionTexts().join(' | ');
    expect(opts).toMatch(/Smith, Mike · RBT/);
    expect(opts).not.toMatch(/Former, Rob/);         // ended excluded
  });

  it('shows No Assigned BCBA / No Assigned RBT when the child has none', async () => {
    listCareTeam.mockResolvedValue([]); // no assignments
    mount(); await flush();
    await pickChild(/Alex R\./); await flush();
    // BCBA type (default): the single select is disabled with a clear placeholder.
    expect(roleField('BCBA').querySelector('.rx-select__trigger').textContent).toMatch(/No assigned BCBA/i);
    // Switching to the RBT type shows the RBT-specific empty state.
    await setType('RBT');
    expect(roleField('RBT').querySelector('.rx-select__trigger').textContent).toMatch(/No assigned RBT/i);
  });

  it('clears the staff selection and loads the new child\u2019s team on child switch', async () => {
    listCareTeam.mockImplementation((cid) => Promise.resolve(
      cid === 'child-A'
        ? [{ id: 'a1', staffProfileId: 'bcba-A', role: 'BCBA', status: 'ACTIVE', staffName: 'Alpha, Ann' }]
        : [{ id: 'b1', staffProfileId: 'bcba-B', role: 'BCBA', status: 'ACTIVE', staffName: 'Bravo, Bob' }],
    ));
    mount(); await flush();
    await pickChild(/Alex R\./); await flush();
    await openRole('BCBA');
    expect(optionTexts().join(' | ')).toMatch(/Alpha, Ann/);
    // close dropdown, switch child
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await Promise.resolve(); });
    await pickChild(/Blair T\./); await flush();
    await openRole('BCBA');
    const opts = optionTexts().join(' | ');
    expect(opts).toMatch(/Bravo, Bob/);
    expect(opts).not.toMatch(/Alpha, Ann/); // stale child-A staff gone
  });
});
