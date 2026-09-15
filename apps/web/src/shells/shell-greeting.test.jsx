import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Shell topbar greeting (retargeted from the old dashboard-page greeting tests).
 *
 * The personalised greeting — "Good <part-of-day>, <First name>" — lives in the
 * role SHELL topbar (BcbaShell / RbtShell), NOT on the dashboard pages, whose
 * header is the static "Dashboard". These tests assert the greeting and the
 * first-name capitalization where the behaviour actually is now, so the
 * dashboard PAGE tests can stay focused on page content without a shell.
 *
 * The greeting text is time-of-day dependent, so the system clock is faked (Date
 * only) to exercise Morning / Afternoon / Evening deterministically. The
 * authenticated name comes from the principal; the stored value is never mutated
 * (formatPersonName only title-cases for display).
 */

const auth = vi.hoisted(() => ({ fullName: 'Aman Khan' }));
vi.mock('@/auth/store', () => ({
  useAuthStore: (sel) => sel({ principal: { user: { fullName: auth.fullName } } }),
}));
vi.mock('@/api/client', () => ({
  fetchBranding: vi.fn(() => Promise.resolve({ name: 'Abstract ABA', logoUrl: null })),
  getRbtPanel: vi.fn(() => Promise.resolve([])),
  getBcbaPanel: vi.fn(() => Promise.resolve([])),
  listClients: vi.fn(() => Promise.resolve({ items: [] })),
  listStaff: vi.fn(() => Promise.resolve({ items: [] })),
}));

import { BcbaShell } from './BcbaShell.jsx';
import { RbtShell } from './RbtShell.jsx';

const SHELLS = [['BcbaShell', BcbaShell], ['RbtShell', RbtShell]];

let container; let root;
beforeEach(() => {
  auth.fullName = 'Aman Khan';
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = undefined;
  vi.useRealTimers();
});

function mountAt(Comp, iso) {
  vi.useFakeTimers({ toFake: ['Date'] });
  if (iso) vi.setSystemTime(new Date(iso));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter><Comp /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
}
const title = () => container.querySelector('.rx-topbar__title')?.textContent ?? '';

describe('shell topbar greeting — part of day', () => {
  for (const [name, Shell] of SHELLS) {
    it(`${name}: Good Morning before noon`, () => {
      mountAt(Shell, '2025-01-06T09:00:00');
      expect(title()).toMatch(/Good Morning, Aman/i);
    });
    it(`${name}: Good Afternoon in the afternoon`, () => {
      mountAt(Shell, '2025-01-06T13:00:00');
      expect(title()).toMatch(/Good Afternoon, Aman/i);
    });
    it(`${name}: Good Evening in the evening`, () => {
      mountAt(Shell, '2025-01-06T20:00:00');
      expect(title()).toMatch(/Good Evening, Aman/i);
    });
  }
});

describe('shell topbar greeting — authenticated first-name capitalization', () => {
  for (const [name, Shell] of SHELLS) {
    it(`${name}: capitalizes a lowercase first name (john -> John)`, () => {
      auth.fullName = 'john smith';
      mountAt(Shell, '2025-01-06T09:00:00');
      expect(title()).toContain(', John');
      expect(title()).not.toContain(', john');
    });
    it(`${name}: normalizes an all-uppercase first name (AMAN -> Aman)`, () => {
      auth.fullName = 'AMAN KHAN';
      mountAt(Shell, '2025-01-06T09:00:00');
      expect(title()).toContain(', Aman');
      expect(title()).not.toContain('AMAN');
    });
    it(`${name}: normalizes a mixed-case first name (aMAN -> Aman)`, () => {
      auth.fullName = 'aMAN kHaN';
      mountAt(Shell, '2025-01-06T09:00:00');
      expect(title()).toContain(', Aman');
    });
  }
});

describe('shell topbar greeting — missing name fallback', () => {
  it('RbtShell falls back to a neutral "there" when there is no name', () => {
    auth.fullName = '';
    mountAt(RbtShell, '2025-01-06T09:00:00');
    expect(title()).toContain(', there');
  });
  it('BcbaShell falls back to the neutral clinical-board header when there is no name', () => {
    auth.fullName = '';
    mountAt(BcbaShell, '2025-01-06T09:00:00');
    expect(title()).toContain('Your clinical board');
  });
});
