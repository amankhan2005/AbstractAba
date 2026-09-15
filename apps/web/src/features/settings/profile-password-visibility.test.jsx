import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Change Password (BCBA and RBT Profile): every password field has its own
 * accessible show / hide control. Toggling changes only the input type — never
 * the value — and does not affect the other fields or the existing API call.
 */
const changePassword = vi.fn(() => Promise.resolve());
vi.mock('@/api/client', () => ({
  updateMyProfile: vi.fn(() => Promise.resolve({})),
  changePassword: (...a) => changePassword(...a),
  fetchMe: vi.fn(() => Promise.resolve({})),
  fetchBranding: vi.fn(() => Promise.resolve({ name: 'Harbor ABA', logoUrl: null })),
}));
const auth = vi.hoisted(() => ({ roles: ['bcba'] }));
vi.mock('@/auth/store', () => {
  const useAuthStore = (sel) => sel({ principal: { user: { fullName: 'Dana Lee', email: 'dana@harbor.test' }, roles: auth.roles } });
  useAuthStore.setState = vi.fn();
  return { useAuthStore };
});

let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); changePassword.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const mount = async () => {
  const { ProfilePage } = await import('./ProfilePage.jsx');
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={qc}><MemoryRouter><ProfilePage /></MemoryRouter></QueryClientProvider>));
};
const input = (id) => host.querySelector(`#${id}`);
const toggleFor = (id) => host.querySelector(`button[aria-controls="${id}"]`);
const type = async (id, value) => {
  const el = input(id);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const FIELDS = ['profile-current-password', 'profile-new-password', 'profile-confirm-password'];

describe.each([['BCBA', ['bcba']], ['RBT', ['rbt']]])('%s Change Password — eye visibility', (_label, roles) => {
  beforeEach(() => { auth.roles = roles; });

  it('each of Current / New / Confirm has its own labelled field and Show password control, hidden by default', async () => {
    await mount();
    for (const id of FIELDS) {
      expect(host.querySelector(`label[for="${id}"]`)).toBeTruthy();
      expect(input(id).type).toBe('password');
      const btn = toggleFor(id);
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.getAttribute('type')).toBe('button');
      expect(btn.getAttribute('aria-label')).toBe('Show password');
      expect(btn.getAttribute('aria-pressed')).toBe('false');
    }
    expect(input('profile-current-password').getAttribute('autocomplete')).toBe('current-password');
    expect(input('profile-new-password').getAttribute('autocomplete')).toBe('new-password');
  });

  it('hidden → visible → hidden, independently per field, keeping the value', async () => {
    await mount();
    await type('profile-current-password', 'old-Secret-1');
    await type('profile-new-password', 'new-Secret-22');
    await type('profile-confirm-password', 'new-Secret-22');

    await act(async () => { toggleFor('profile-new-password').click(); });
    expect(input('profile-new-password').type).toBe('text');
    expect(input('profile-new-password').value).toBe('new-Secret-22');
    expect(toggleFor('profile-new-password').getAttribute('aria-label')).toBe('Hide password');
    expect(toggleFor('profile-new-password').getAttribute('aria-pressed')).toBe('true');
    // The other fields are unaffected.
    expect(input('profile-current-password').type).toBe('password');
    expect(input('profile-confirm-password').type).toBe('password');

    await act(async () => { toggleFor('profile-new-password').click(); });
    expect(input('profile-new-password').type).toBe('password');
    expect(input('profile-new-password').value).toBe('new-Secret-22');
    expect(toggleFor('profile-new-password').getAttribute('aria-label')).toBe('Show password');

    // Toggling never submits; the existing change-password API is called only by its button.
    expect(changePassword).not.toHaveBeenCalled();
    const submit = [...host.querySelectorAll('button')].find((b) => /Change password/.test(b.textContent));
    await act(async () => { submit.click(); });
    expect(changePassword).toHaveBeenCalledWith({ currentPassword: 'old-Secret-1', newPassword: 'new-Secret-22' });
  });

  it('the mismatch validation still works with visible fields', async () => {
    await mount();
    await act(async () => { toggleFor('profile-confirm-password').click(); });
    await type('profile-new-password', 'abcdefghij1');
    await type('profile-confirm-password', 'abcdefghij2');
    expect(host.textContent).toContain('Passwords do not match.');
    expect(input('profile-confirm-password').type).toBe('text');
  });
});
