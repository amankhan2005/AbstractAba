import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * REGRESSION — CompanyShell.jsx:37
 *   "Uncaught ReferenceError: useQuery is not defined"
 *
 * The branding change added `useQuery(...)` and `fetchBranding` calls to
 * CompanyShell but the imports for them were missing. esbuild does not fail on
 * an undefined identifier, so the build and the existing (pure) shell tests
 * passed while the component threw at runtime the moment it mounted. This test
 * MOUNTS the real CompanyShell so a missing import can never pass again.
 */

// Branding fetch is mocked so the test doesn't hit the network; the point is
// that the component imports and calls it without crashing.
vi.mock('@/api/client', () => ({
  fetchBranding: vi.fn(() => Promise.resolve({ name: 'ABC Behavioral Health', logoUrl: null })),
}));

let CompanyShell;
let container;
let root;

beforeEach(async () => {
  ({ CompanyShell } = await import('./CompanyShell.jsx'));
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
});

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <CompanyShell />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe('CompanyShell (branding regression)', () => {
  it('mounts without a ReferenceError and renders the platform fallback name immediately', () => {
    expect(() => renderShell()).not.toThrow();
    // Before the branding query resolves, the shared product name is shown.
    expect(container.textContent).toContain('Abstract ABA');
    expect(container.textContent).not.toContain('ABA1ON1');
    expect(container.textContent).toContain('Clinic Operations');
  });

  it('does not render the Abstract ABA / WebieApp product signature in the Company sidebar', () => {
    renderShell();
    expect(container.querySelector('.rx-productsig')).toBeNull();
    expect(container.textContent).not.toMatch(/Product of WebieApp Solutions LLC/);
    expect(container.textContent).toContain('Clinic Operations'); // navigation/brand area intact
  });

  it('shows the company name once branding resolves', async () => {
    renderShell();
    // poll for the async react-query state update to flush (no fixed delays)
    let seen = false;
    for (let i = 0; i < 50 && !seen; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      seen = container.textContent.includes('ABC Behavioral Health');
    }
    expect(seen).toBe(true);
  });
});
