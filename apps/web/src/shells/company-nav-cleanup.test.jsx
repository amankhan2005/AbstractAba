import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Navigation cleanup:
 *   - The Claim page is gone from the Company sidebar.
 *   - The standalone "Account & security" item is gone from the Company sidebar
 *     (Company password management lives in Company Profile) — but stays for the
 *     clinician (BCBA) shell, which has no Company Profile.
 *   - Company Profile remains in the Company sidebar.
 */

vi.mock('@/api/client', () => ({
  fetchBranding: vi.fn(() => Promise.resolve({ name: 'ABC Behavioral Health', logoUrl: null })),
}));

let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; });

const render = async (Comp) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => root.render(<QueryClientProvider client={qc}><MemoryRouter><Comp /></MemoryRouter></QueryClientProvider>));
  // allow branding query to flush
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const links = () => [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));

describe('Company sidebar cleanup', () => {
  it('has no Claims link and no standalone Account & security link, but keeps Company Profile', async () => {
    const { CompanyShell } = await import('./CompanyShell.jsx');
    await render(CompanyShell);
    expect(host.textContent).not.toMatch(/Claims/);
    expect(host.textContent).not.toMatch(/Account\s*&\s*security/i);
    expect(links().some((h) => h === '/claims')).toBe(false);
    expect(links().some((h) => h === '/account')).toBe(false);
    // Company Profile (the single company password-management location) stays.
    expect(host.textContent).toMatch(/Company Profile/);
    expect(links().some((h) => h && h.includes('/settings/company'))).toBe(true);
  });
});

describe('Clinician (BCBA) sidebar', () => {
  it('replaces Account & security with a Profile page, and drops Staff/Supervision (spec §2/§3/§16)', async () => {
    const { BcbaShell } = await import('./BcbaShell.jsx');
    await render(BcbaShell);
    // Account & security is gone; a dedicated Profile page replaces it.
    expect(host.textContent).not.toMatch(/Account\s*&\s*security/i);
    expect(links().some((h) => h === '/account')).toBe(false);
    expect(host.textContent).toMatch(/Profile/);
    expect(links().some((h) => h === '/profile')).toBe(true);
    // Staff/Supervisees and the Supervision log are not in the BCBA rail.
    expect(links().some((h) => h === '/staff')).toBe(false);
    expect(links().some((h) => h === '/supervision')).toBe(false);
    // ...and never a Claims link.
    expect(links().some((h) => h === '/claims')).toBe(false);
    // Core caseload routes remain, each exactly once.
    for (const route of ['/dashboards/bcba', '/plans', '/sessions', '/sessions/panel', '/scheduling', '/profile']) {
      expect(links().filter((h) => h === route).length, `one canonical link for ${route}`).toBe(1);
    }
  });
});
