import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Profile page (spec §14/§15): the BCBA edits their own name; email is
 * read-only. And the shared sidebar collapse toggle (§4). Both act()-clean.
 */

const updateMyProfile = vi.fn(() => Promise.resolve({ id: 'u-1', fullName: 'Aman Verma', email: 'aman@example.com' }));
const changePassword = vi.fn(() => Promise.resolve());
const fetchMe = vi.fn(() => Promise.resolve({ user: { id: 'u-1', fullName: 'Aman Verma', email: 'aman@example.com' } }));
vi.mock('@/api/client', () => ({
  updateMyProfile: (...a) => updateMyProfile(...a),
  changePassword: (...a) => changePassword(...a),
  fetchMe: (...a) => fetchMe(...a),
  fetchBranding: vi.fn(() => Promise.resolve({ name: 'ABC', logoUrl: null })),
}));
vi.mock('@/auth/store', () => {
  const store = { principal: { user: { fullName: 'Aman Kumar', email: 'aman@example.com' } } };
  const useAuthStore = (sel) => sel(store);
  useAuthStore.setState = vi.fn();
  return { useAuthStore };
});

let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); updateMyProfile.mockClear(); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; });

const render = async (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => root.render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

describe('ProfilePage', () => {
  it('shows the email as read-only and pre-fills the split name', async () => {
    const { ProfilePage } = await import('./ProfilePage.jsx');
    await render(<ProfilePage />);
    expect(host.textContent).toMatch(/Email cannot be changed/i);
    const email = [...host.querySelectorAll('input')].find((i) => i.value === 'aman@example.com');
    expect(email).toBeTruthy();
    expect(email.disabled).toBe(true); // email is not editable
    // name split from fullName "Aman Kumar"
    const values = [...host.querySelectorAll('input')].map((i) => i.value);
    expect(values).toContain('Aman');
    expect(values).toContain('Kumar');
  });

  it('saves the edited name via updateMyProfile (never sends email)', async () => {
    const { ProfilePage } = await import('./ProfilePage.jsx');
    await render(<ProfilePage />);
    const save = [...host.querySelectorAll('button')].find((b) => /Save changes/.test(b.textContent));
    await act(async () => { save.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(updateMyProfile).toHaveBeenCalledWith({ firstName: 'Aman', lastName: 'Kumar' });
    // the payload has no email key
    expect(updateMyProfile.mock.calls[0][0]).not.toHaveProperty('email');
  });
});

describe('useSidebarCollapsed', () => {
  it('toggles and persists to localStorage', async () => {
    const mod = await import('@/shells/useSidebarCollapsed.js');
    let api;
    function Probe() { api = mod.useSidebarCollapsed(); return <div>{String(api.collapsed)}</div>; }
    root = createRoot(host);
    act(() => root.render(<Probe />));
    expect(host.textContent).toContain('false');
    act(() => api.toggle());
    expect(host.textContent).toContain('true');
    expect(localStorage.getItem('aba1on1.sidebar.collapsed')).toBe('1');
    act(() => api.toggle());
    expect(localStorage.getItem('aba1on1.sidebar.collapsed')).toBe('0');
  });
});
