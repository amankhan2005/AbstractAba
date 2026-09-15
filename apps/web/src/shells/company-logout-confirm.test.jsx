import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components';

/**
 * Company Panel — logout confirmation. Logout asks "Log out?" first; Cancel
 * keeps the session; "Log out" runs the EXISTING sign-out (POST
 * /v1/auth/sign-out via the API client, then the store's unauthenticated state
 * the route guard sends to /login) exactly once. The clinician shells keep
 * their direct sign-out.
 */
const signOut = vi.fn();
vi.mock('@/features/sessions/BcbaActiveSessionBar.jsx', () => ({ BcbaActiveSessionBar: () => null }));
vi.mock('@/features/sessions/RbtActiveSessionBar.jsx', () => ({ RbtActiveSessionBar: () => null }));
vi.mock('@/api/client', () => ({
  fetchBranding: vi.fn(() => Promise.resolve({ name: 'Harbor ABA', logoUrl: null })),
  signOut: (...a) => signOut(...a),
}));

let useAuthStore; let CompanyShell; let ShellFrame;
let host; let root;

beforeEach(async () => {
  ({ useAuthStore } = await import('@/auth/store'));
  ({ CompanyShell } = await import('./CompanyShell.jsx'));
  ({ ShellFrame } = await import('./ShellFrame.jsx'));
  useAuthStore.setState({ status: 'authenticated', principal: { user: { fullName: 'dana lee', email: 'dana@harbor.test' }, organizationTimezone: 'America/New_York', permissions: [] } });
  signOut.mockReset();
  host = document.createElement('div'); document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  document.querySelectorAll('.rx-modal').forEach((m) => m.remove());
  useAuthStore.setState({ status: 'unknown', principal: null });
});

const render = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => root.render(<QueryClientProvider client={qc}><ToastProvider><MemoryRouter>{ui}</MemoryRouter></ToastProvider></QueryClientProvider>));
};
const logoutButton = () => host.querySelector('.rx-aside__foot .rx-iconbtn');
const modal = () => document.querySelector('.rx-modal[class*="rx-modal--"]');
const modalButton = (label) => [...document.querySelectorAll('.rx-modal__foot button')].find((b) => b.textContent.trim() === label);
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };

describe('Company Panel logout confirmation', () => {
  it('Logout opens a compact confirmation and does not log out yet', async () => {
    render(<CompanyShell />);
    expect(logoutButton().getAttribute('aria-label')).toBe('Log out');
    await act(async () => { logoutButton().click(); });
    expect(modal()).toBeTruthy();
    expect(document.querySelector('.rx-modal__title').textContent).toBe('Log out?');
    expect(document.querySelector('.rx-modal__desc').textContent).toBe('Are you sure you want to log out?');
    expect(document.querySelector('.rx-modal__panel--sm')).toBeTruthy();
    expect([...document.querySelectorAll('.rx-modal__foot button')].map((b) => b.textContent.trim())).toEqual(['Cancel', 'Log out']);
    expect(signOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('Cancel closes the dialog and keeps the user logged in', async () => {
    render(<CompanyShell />);
    await act(async () => { logoutButton().click(); });
    await act(async () => { modalButton('Cancel').click(); });
    // The dialog animates out; wait for it to leave the DOM.
    for (let i = 0; i < 40 && document.querySelector('.rx-modal__title'); i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(document.querySelector('.rx-modal__title')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('Log out runs the existing sign-out once, shows progress, then ends the session', async () => {
    let finish;
    signOut.mockImplementation(() => new Promise((r) => { finish = r; }));
    render(<CompanyShell />);
    await act(async () => { logoutButton().click(); });
    await act(async () => { modalButton('Log out').click(); });
    await act(async () => { modalButton('Log out').click(); }); // duplicate click while in progress
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(modalButton('Log out').disabled).toBe(true);
    expect(modalButton('Log out').querySelector('.rx-spinner')).toBeTruthy();
    expect(modalButton('Cancel').disabled).toBe(true);
    // Escape cannot dismiss the dialog mid-logout.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(document.querySelector('.rx-modal__title')?.textContent).toBe('Log out?');
    expect(useAuthStore.getState().status).toBe('authenticated');

    await act(async () => { finish(); });
    await flush();
    expect(useAuthStore.getState()).toMatchObject({ status: 'unauthenticated', principal: null });
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('when the server cannot be reached the user is told, and the local session still ends (existing API-client contract)', async () => {
    signOut.mockRejectedValue(new Error('Network Error'));
    render(<CompanyShell />);
    await act(async () => { logoutButton().click(); });
    await act(async () => { modalButton('Log out').click(); });
    await flush();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(document.body.textContent).toContain('You have been logged out on this device.');
  });

  it('the BCBA and RBT portals ask for the same confirmation', async () => {
    const { BcbaShell } = await import('./BcbaShell.jsx');
    const { RbtShell } = await import('./RbtShell.jsx');
    for (const Shell of [BcbaShell, RbtShell]) {
      render(<Shell />);
      expect(document.body.dataset.portal).toMatch(/^(bcba|rbt)$/);
      await act(async () => { logoutButton().click(); });
      expect(document.querySelector('.rx-modal__title').textContent).toBe('Log out?');
      expect(signOut).not.toHaveBeenCalled();
      act(() => root.unmount()); root = undefined;
      document.querySelectorAll('.rx-modal').forEach((m) => m.remove());
    }
  });

  it('a shell without confirmSignOut signs out directly', async () => {
    signOut.mockResolvedValue();
    render(<ShellFrame shellClass="rx-shell--demo" brand={{ name: 'Harbor ABA' }} roleLabel="Demo" nav={[]} topbar={{ title: 'Demo' }} />);
    expect(logoutButton().getAttribute('aria-label')).toBe('Sign out');
    await act(async () => { logoutButton().click(); });
    await flush();
    expect(document.querySelector('.rx-modal__title')).toBeNull();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });
});
