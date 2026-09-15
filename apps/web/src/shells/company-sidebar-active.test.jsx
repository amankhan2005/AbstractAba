import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * COMPANY SIDEBAR — "Sessions" and "Session insights" were both highlighted on
 * /sessions/oversight. Root cause: the Sessions item (to: '/sessions') had no
 * `end`, so NavLink's prefix matching also activated it on the nested
 * /sessions/oversight route. The shell now matches routes exactly: an item is
 * active on its own route (or declared detail patterns such as
 * /sessions/:sessionId), never on a route that belongs to another nav item.
 * Rendered through the REAL CompanyShell, so the real nav config is tested.
 */
vi.mock('@/api/client', () => ({ fetchBranding: vi.fn(async () => ({ name: 'Demo ABA Clinic' })), globalSearch: vi.fn(async () => ({ items: [] })), signOut: vi.fn() }));
vi.mock('@/auth/store', () => ({
  useAuthStore: Object.assign((sel) => sel({ status: 'authenticated', principal: { roles: ['org_admin'], permissions: [], user: { fullName: 'Demo Admin', email: 'admin@example.test' } } }), { setState: vi.fn() }),
  useOrgTimezone: () => 'UTC',
}));

let host; let root; let lastTopbar;
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); root = undefined; host = undefined; });

async function activeAt(path) {
  const { CompanyShell } = await import('./CompanyShell.jsx');
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route element={<CompanyShell />}><Route path="*" element={<div>page</div>} /></Route></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const aside = host.querySelector('.rx-shell__aside');
  const active = [...aside.querySelectorAll('.rx-nav__link.is-active')].map((n) => n.textContent.trim());
  const current = [...aside.querySelectorAll('.rx-nav__link[aria-current="page"]')].map((n) => n.textContent.trim());
  lastTopbar = [host.querySelector('.rx-topbar__title')?.textContent, host.querySelector('.rx-topbar__sub')?.textContent];
  act(() => root.unmount()); host.remove(); root = undefined; host = undefined;
  return { active, current };
}

describe('Company sidebar active state', () => {
  it('/sessions → only Sessions', async () => {
    expect(await activeAt('/sessions')).toEqual({ active: ['Sessions'], current: ['Sessions'] });
  });
  it('/sessions/oversight → only Session Insights', async () => {
    expect(await activeAt('/sessions/oversight')).toEqual({ active: ['Session Insights'], current: ['Session Insights'] });
  });
  it('Treatment Plans, Insurance Billing and Company Profile activate only on their own routes', async () => {
    expect((await activeAt('/plans')).active).toEqual(['Treatment Plans']);
    expect((await activeAt('/plans/abc/edit')).active).toEqual(['Treatment Plans']);
    expect((await activeAt('/insurance-billing')).active).toEqual(['Billing']);
    expect((await activeAt('/settings/company')).active).toEqual(['Company Profile']);
    expect((await activeAt('/dashboards/admin')).active).toEqual(['Dashboard']);
  });
  it('/sessions/:sessionId (detail) → only Sessions', async () => {
    expect((await activeAt('/sessions/01a09b92-da39-728a-9934-132c4934996f')).active).toEqual(['Sessions']);
  });
  it('the two items are never active together on any sessions route', async () => {
    for (const path of ['/sessions', '/sessions/oversight', '/sessions/abc', '/sessions/new']) {
      const { active } = await activeAt(path);
      expect(active.filter((l) => l === 'Sessions' || l === 'Session Insights').length, path).toBeLessThanOrEqual(1);
    }
  });
  it('other items keep exact matching (Payroll, Clients)', async () => {
    expect((await activeAt('/payroll')).active).toEqual(['Payroll']);
    expect((await activeAt('/clients/123')).active).toEqual(['Clients']);
  });
  it('the Company sidebar has no Timesheets item; Session Insights, Treatment Plans and Subscription remain', async () => {
    const { CompanyShell } = await import('./CompanyShell.jsx');
    expect(CompanyShell).toBeTruthy();
    const { active } = await activeAt('/subscription');
    expect(active).toEqual(['Subscription']);
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/']}><Routes><Route element={<CompanyShell />}><Route path="*" element={<div>page</div>} /></Route></Routes></MemoryRouter></QueryClientProvider>));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const labels = [...host.querySelectorAll('.rx-shell__aside .rx-nav__link')].map((n) => n.textContent.trim());
    expect(labels).not.toContain('Timesheets');
    expect(labels).toEqual(['Dashboard', 'Clients', 'Staff', 'Scheduling', 'Sessions', 'Session Insights', 'Treatment Plans', 'Insurance Billing', 'Payroll', 'Subscription', 'Company Profile', 'Email Templates']);
    expect([...host.querySelectorAll('.rx-nav__label')].map((n) => n.textContent)).toEqual(['Overview', 'Care', 'Finance', 'Settings']);
  });
});

describe('Company top bar', () => {
  it('names the current page and its section instead of one fixed title', async () => {
    await activeAt('/clients/123');
    expect(lastTopbar).toEqual(['Clients', 'Clinic Operations · Care']);
    await activeAt('/payroll');
    expect(lastTopbar).toEqual(['Payroll', 'Clinic Operations · Finance']);
    await activeAt('/somewhere-else');
    expect(lastTopbar).toEqual(['Clinic Operations', 'Organization-wide command center']);
  });
});

describe('isNavItemActive (shared by every shell)', () => {
  it('BCBA: Review queue and Session panel stay exclusive', async () => {
    const { isNavItemActive } = await import('./ShellFrame.jsx');
    const items = [{ to: '/sessions', end: true }, { to: '/sessions/panel' }, { to: '/sessions/manual' }];
    const targets = items.map((i) => i.to);
    const activeFor = (p) => items.filter((i) => isNavItemActive(i, p, targets)).map((i) => i.to);
    expect(activeFor('/sessions')).toEqual(['/sessions']);
    expect(activeFor('/sessions/panel')).toEqual(['/sessions/panel']);
    expect(activeFor('/sessions/manual')).toEqual(['/sessions/manual']);
  });
});
