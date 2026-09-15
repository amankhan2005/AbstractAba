import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';

/**
 * ShellFrame user area (sidebar/header) — the authenticated user's name is shown
 * with each component capitalized, so their first name always begins with a
 * capital across the BCBA and RBT panel chrome (name-capitalization fix). The
 * stored value is never changed, and the email fallback is shown verbatim (an
 * email must never be title-cased).
 */

const authState = vi.hoisted(() => ({ principal: { user: { fullName: 'Aman Khan', email: 'a@x.com' } } }));
const useAuthStore = vi.hoisted(() => {
  const fn = (sel) => sel(authState);
  fn.setState = () => {};
  return fn;
});
vi.mock('@/auth/store', () => ({ useAuthStore }));
vi.mock('@/api/client', () => ({ signOut: () => Promise.resolve() }));
vi.mock('./GlobalSearch.jsx', () => ({ GlobalSearch: () => null }));

let host; let root; let ShellFrame;
beforeEach(async () => { ({ ShellFrame } = await import('./ShellFrame.jsx')); });
afterEach(() => { if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined; });

const mount = () => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(
    <MemoryRouter initialEntries={['/dashboards/rbt']}>
      <ShellFrame shellClass="rx-shell--rbt" brand={{ name: 'Abstract ABA', logoUrl: null, mark: null }} roleLabel="RBT Panel" nav={[]} topbar={{ title: 'RBT Panel', subtitle: 'x' }} />
    </MemoryRouter>,
  ));
};
const chipName = () => host.querySelector('.rx-userchip__name')?.textContent ?? '';

describe('ShellFrame user-area name capitalization', () => {
  it('capitalizes a lowercase full name (john smith → John Smith)', () => {
    authState.principal = { user: { fullName: 'john smith', email: 'j@x.com' } };
    mount();
    expect(chipName()).toBe('John Smith');
  });

  it('normalizes an all-uppercase name (AMAN KHAN → Aman Khan)', () => {
    authState.principal = { user: { fullName: 'AMAN KHAN', email: 'a@x.com' } };
    mount();
    expect(chipName()).toBe('Aman Khan');
  });

  it('shows the email fallback verbatim when there is no name (never title-cased)', () => {
    authState.principal = { user: { fullName: '', email: 'jane.doe@example.com' } };
    mount();
    expect(chipName()).toBe('jane.doe@example.com');
  });
});
