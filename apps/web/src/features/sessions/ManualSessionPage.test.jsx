import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Manual Session page (BCBA & RBT). Client, Date (MM/DD/YYYY), From/To in
 * 15-minute steps, Authorization(s), Session Memo → "Add Manual Session".
 * Posts to the role's endpoint WITHOUT any clinician/tenant/duration field,
 * shows server errors verbatim, confirms success, and refreshes session/hours
 * queries. Users without a BCBA/RBT role are redirected.
 */
const listClients = vi.fn();
const listAuthorizations = vi.fn();
const createBcbaManualSession = vi.fn();
const createRbtManualSession = vi.fn();
vi.mock('@/api/client', () => ({
  listClients: (...a) => listClients(...a),
  listAuthorizations: (...a) => listAuthorizations(...a),
  createBcbaManualSession: (...a) => createBcbaManualSession(...a),
  createRbtManualSession: (...a) => createRbtManualSession(...a),
}));
const toasts = vi.hoisted(() => []);
vi.mock('@/components', () => ({ useToast: () => ({ push: (m) => toasts.push(m) }) }));
const auth = vi.hoisted(() => ({ roles: ['bcba'] }));
vi.mock('@/auth/store', () => ({ useAuthStore: (sel) => sel({ principal: { roles: auth.roles } }), useOrgTimezone: () => 'America/New_York' }));

let host; let root; let ManualSessionPage; let TIME_OPTIONS; let qc;

beforeEach(async () => {
  ({ ManualSessionPage, TIME_OPTIONS } = await import('./ManualSessionPage.jsx'));
  auth.roles = ['bcba'];
  toasts.length = 0;
  listClients.mockReset().mockResolvedValue({ items: [{ id: 'child-1', firstName: 'Test', lastName: 'Child' }] });
  listAuthorizations.mockReset().mockResolvedValue({ items: [
    { id: 'svc:aba', clientId: 'child-1', status: 'ACTIVE', serviceCode: '97153', payerName: 'Acme Health', authorizationNumber: 'AUTH-100', startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z' },
    { id: 'svc:fba', clientId: 'child-1', status: 'ACTIVE', serviceCode: '97151', payerName: 'Acme Health', authorizationNumber: 'AUTH-200', startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-12-31T00:00:00.000Z' },
    { id: 'svc:pending', clientId: 'child-1', status: 'PENDING', serviceCode: '97155', authorizationNumber: 'AUTH-300', startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z' },
    { id: 'svc:old', clientId: 'child-1', status: 'ACTIVE', serviceCode: '97153', authorizationNumber: 'AUTH-OLD', startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-08-31T00:00:00.000Z' },
  ] });
  createBcbaManualSession.mockReset(); createRbtManualSession.mockReset();
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); document.body.innerHTML = ''; root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/sessions/manual']}>
        <Routes>
          <Route path="/sessions/manual" element={<ManualSessionPage />} />
          <Route path="/" element={<div>Home page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
};
const settle = async () => { for (let i = 0; i < 25; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const field = (label) => [...host.querySelectorAll('.rx-formfield')].find((f) => f.querySelector('label')?.textContent.replace('*', '').trim() === label);
const choose = async (label, optionText) => {
  const f = field(label);
  await act(async () => { f.querySelector('.rx-select__trigger').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const opt = [...f.querySelectorAll('.rx-select__opt')].find((o) => o.textContent.trim() === optionText);
  await act(async () => { opt.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
};
const typeDate = async (raw) => {
  const el = host.querySelector('input[aria-label="Session date"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, raw);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle();
};
const addBtn = () => [...host.querySelectorAll('button')].find((b) => /Add Manual Session/.test(b.textContent));
const clickAdd = async () => { await act(async () => { addBtn().dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await settle(); };
const checkAuth = async (num) => {
  const box = [...host.querySelectorAll('.rx-manual__auth')].find((l) => l.textContent.includes(num)).querySelector('input');
  await act(async () => { box.click(); });
};
const typeMemo = async (text) => {
  const memo = host.querySelector('textarea');
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(memo, text);
  await act(async () => { memo.dispatchEvent(new Event('input', { bubbles: true })); });
};
async function fillValid() {
  await choose('Client', 'Test Child');
  await typeDate('09132026');
  await choose('From', '10:00 AM');
  await choose('To', '11:30 AM');
  await checkAuth('AUTH-100');
  await typeMemo('Manual session');
}

describe('ManualSessionPage', () => {
  it('renders exactly the required fields and the primary action — no review/approve/start/stop', async () => {
    mount(); await settle();
    expect(host.querySelector('h1').textContent).toBe('Manual Session');
    for (const label of ['Client', 'Date', 'From', 'To', 'Authorization(s)', 'Session Memo']) expect(field(label), label).toBeTruthy();
    expect(addBtn()).toBeTruthy();
    expect(host.textContent).not.toMatch(/Review|Approve|Submit for approval|Start Session|Stop Session|What did you work on/i);
    expect(host.querySelector('textarea').getAttribute('placeholder')).toBe('Add a session memo...');
  });

  it('time options are 15-minute increments only', () => {
    expect(TIME_OPTIONS).toHaveLength(96);
    expect(TIME_OPTIONS.every((o) => /:(00|15|30|45)$/.test(o.value))).toBe(true);
    expect(TIME_OPTIONS.map((o) => o.label)).toEqual(expect.arrayContaining(['9:00 AM', '9:15 AM', '9:30 AM', '9:45 AM', '10:00 AM']));
    expect(TIME_OPTIONS.map((o) => o.label)).not.toContain('9:10 AM');
  });

  it('BCBA: offers only approved authorizations valid on the date and posts the exact payload (no clinician/tenant/duration)', async () => {
    createBcbaManualSession.mockResolvedValue({ session: { id: 's1' }, timeRecord: { workedMinutes: 90 }, alreadyExists: false });
    mount(); await settle();
    await choose('Client', 'Test Child');
    expect(listAuthorizations).toHaveBeenCalledWith({ clientId: 'child-1' });
    await typeDate('09132026');
    const offered = [...host.querySelectorAll('.rx-manual__auth')].map((l) => l.textContent);
    expect(offered.some((t) => t.includes('AUTH-100') && t.includes('09/01/2026 – 09/30/2026'))).toBe(true);
    expect(offered.some((t) => t.includes('AUTH-200'))).toBe(true);
    expect(offered.some((t) => t.includes('AUTH-300'))).toBe(false); // pending
    expect(offered.some((t) => t.includes('AUTH-OLD'))).toBe(false); // not valid on 09/13
    await choose('From', '10:00 AM');
    await choose('To', '11:30 AM');
    expect(field('To').textContent).toContain('1h 30m worked');
    await checkAuth('AUTH-100');
    await checkAuth('AUTH-200');
    await typeMemo('Manual session');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await clickAdd();
    expect(createBcbaManualSession).toHaveBeenCalledWith({
      clientId: 'child-1', date: '2026-09-13', startTime: '10:00', endTime: '11:30', authorizationIds: ['svc:aba', 'svc:fba'], memo: 'Manual session',
    });
    const body = createBcbaManualSession.mock.calls[0][0];
    for (const k of ['staffProfileId', 'tenantId', 'userId', 'role', 'workedMinutes', 'duration']) expect(body).not.toHaveProperty(k);
    expect(createRbtManualSession).not.toHaveBeenCalled();
    expect(toasts).toContain('Manual session added successfully.');
    const keys = spy.mock.calls.map((c) => c[0].queryKey[0]);
    for (const k of ['sessions', 'bcba', 'rbt', 'payroll']) expect(keys).toContain(k);
  });

  it('RBT posts to the RBT endpoint', async () => {
    auth.roles = ['rbt'];
    createRbtManualSession.mockResolvedValue({ session: { id: 's2' }, alreadyExists: false });
    mount(); await settle();
    await fillValid();
    await clickAdd();
    expect(createRbtManualSession).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'child-1', startTime: '10:00', endTime: '11:30', authorizationIds: ['svc:aba'] }));
    expect(createBcbaManualSession).not.toHaveBeenCalled();
  });

  it('client-side validation: required fields, end after start, authorization required', async () => {
    mount(); await settle();
    await clickAdd();
    expect(host.querySelector('[role="alert"]').textContent).toBe('Select a client, date, start time and end time.');
    await choose('Client', 'Test Child');
    await typeDate('09132026');
    await choose('From', '11:30 AM');
    await choose('To', '10:00 AM');
    await clickAdd();
    expect(host.querySelector('[role="alert"]').textContent).toBe('End time must be after start time.');
    await choose('To', '12:00 PM');
    await clickAdd();
    expect(host.querySelector('[role="alert"]').textContent).toBe('Select an authorization for this client.');
    expect(createBcbaManualSession).not.toHaveBeenCalled();
  });

  it('shows real server errors verbatim (e.g. conflict) — no fake success', async () => {
    createBcbaManualSession.mockRejectedValue({ response: { data: { error: { code: 'SESSION_CONFLICT', message: 'This session conflicts with an existing session.' } } } });
    mount(); await settle();
    await fillValid();
    await clickAdd();
    expect(host.querySelector('[role="alert"]').textContent).toBe('This session conflicts with an existing session.');
    expect(toasts).toHaveLength(0);
  });

  it('an idempotent repeat is reported honestly', async () => {
    createBcbaManualSession.mockResolvedValue({ session: { id: 's1' }, alreadyExists: true });
    mount(); await settle();
    await fillValid();
    await clickAdd();
    expect(toasts).toEqual(['This manual session was already added.']);
  });

  it('a user without a BCBA or RBT role is redirected away (e.g. Company Admin)', async () => {
    auth.roles = ['org_admin'];
    mount(); await settle();
    expect(host.textContent).toBe('Home page');
    expect(listClients).not.toHaveBeenCalled();
  });
});
