import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Phase 2 — BCBA/RBT shells render the backend-derived company branding without
 * crashing, and fall back to the Abstract ABA product name before branding resolves. Mirrors
 * the CompanyShell regression guard (missing shell imports pass the build but
 * throw at mount, so we MOUNT the real shells here).
 */
vi.mock('@/api/client', () => ({
  fetchBranding: vi.fn(() => Promise.resolve({ name: 'Company A Behavioral', logoUrl: null })),
}));

let container; let root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
afterEach(() => { act(() => { root?.unmount(); }); container?.remove(); });

async function mount(Comp) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  act(() => { root.render(<QueryClientProvider client={qc}><MemoryRouter><Comp /></MemoryRouter></QueryClientProvider>); });
}
async function waitFor(text) {
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    if (container.textContent.includes(text)) return true;
  }
  return false;
}

describe('BcbaShell branding', () => {
  it('mounts without crashing, shows the BCBA Panel label and the Abstract ABA fallback first', async () => {
    const { BcbaShell } = await import('./BcbaShell.jsx');
    await expect(mount(BcbaShell)).resolves.not.toThrow?.();
    expect(container.textContent).toContain('BCBA Panel');
    expect(container.textContent).toContain('Abstract ABA');
    expect(container.textContent).not.toContain('ABA1ON1');
  });
  it('shows the resolved company name once branding loads', async () => {
    const { BcbaShell } = await import('./BcbaShell.jsx');
    await mount(BcbaShell);
    expect(await waitFor('Company A Behavioral')).toBe(true);
  });
});

describe('Product signature in every portal shell', () => {
  for (const name of ['BcbaShell', 'RbtShell']) {
    it(`${name} shows the Abstract ABA logo and "Product of WebieApp Solutions LLC", separate from the customer brand`, async () => {
      const mod = await import(`./${name}.jsx`);
      await mount(mod[name]);
      const sig = container.querySelector('.rx-productsig');
      expect(sig.querySelector('img').getAttribute('src')).toBe('/logo.png');
      expect(sig.textContent).toMatch(/Product of WebieApp Solutions LLC/);
      expect(container.textContent).not.toMatch(/Powered by/);
      expect(await waitFor('Company A Behavioral')).toBe(true); // customer name still shown at the top
    });
  }
});

describe('RbtShell branding', () => {
  it('mounts without crashing and shows the RBT Panel label', async () => {
    const { RbtShell } = await import('./RbtShell.jsx');
    await mount(RbtShell);
    expect(container.textContent).toContain('RBT Panel');
    expect(container.textContent).toContain('Abstract ABA');
    expect(container.textContent).not.toContain('ABA1ON1');
  });
  it('shows the resolved company name once branding loads', async () => {
    const { RbtShell } = await import('./RbtShell.jsx');
    await mount(RbtShell);
    expect(await waitFor('Company A Behavioral')).toBe(true);
  });
});
