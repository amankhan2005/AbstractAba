import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * REGRESSION — act() warnings during the login flow.
 *
 * ROOT CAUSE. LoginPageNew.submit() fired the store action fire-and-forget
 * (`void signIn(...)`). The store's terminal `set(next)` after `await fetchMe()`
 * (store.js) therefore landed on a later microtask — after the synchronous
 * submit handler returned — so the resulting LoginPageNew/App re-render (and the
 * <Navigate> it triggers) fell OUTSIDE any act() a test wrapped around the click:
 *
 *     Warning: An update to LoginPageNew was not wrapped in act(...)
 *     Warning: An update to App was not wrapped in act(...)
 *
 * FIX. submit() now awaits signIn(); the store single-flights concurrent
 * sign-ins. This test drives the REAL component + REAL store (only the network
 * client is mocked) and flushes the async resolution INSIDE act(), so the whole
 * transition is wrapped. The console.error guard fails the test on ANY
 * "not wrapped in act" warning — the warning is caught, never suppressed.
 */

const signIn = vi.fn();
const fetchMe = vi.fn();
const setAccessToken = vi.fn();
const restoreSession = vi.fn();
const hasRestorableSession = vi.fn(() => false);

vi.mock('@/api/client', () => ({
  signIn: (...a) => signIn(...a),
  fetchMe: (...a) => fetchMe(...a),
  signOut: vi.fn(),
  setAccessToken: (...a) => setAccessToken(...a),
  clearSessionHint: vi.fn(),
  restoreSession: (...a) => restoreSession(...a),
  hasRestorableSession: (...a) => hasRestorableSession(...a),
  markSessionEstablished: vi.fn(),
}));

let useAuthStore; let LoginPageNew;
let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  ({ useAuthStore } = await import('@/auth/store'));
  ({ LoginPageNew } = await import('./LoginPageNew.jsx'));
  signIn.mockReset(); fetchMe.mockReset(); setAccessToken.mockReset();
  restoreSession.mockReset(); hasRestorableSession.mockReset().mockReturnValue(false);
  act(() => useAuthStore.setState({ status: 'unknown', principal: null, error: null }));
});

let host; let root;
const mount = () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPageNew />} />
          <Route path="/" element={<div>PANEL_HOME</div>} />
        </Routes>
      </MemoryRouter>,
    );
  });
};

afterEach(() => {
  if (root) act(() => root.unmount());
  if (host) host.remove();
  root = undefined; host = undefined;
  const warnings = actWarnings();
  consoleErrorSpy.mockRestore();
  expect(warnings, `act() warnings: ${JSON.stringify(warnings)}`).toHaveLength(0);
});

const setInput = (id, value) => {
  const input = host.querySelector(`#${id}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
};
const submitForm = async () => {
  const form = host.querySelector('form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // Flush the awaited signIn → fetchMe → set(next) chain inside act().
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const fillValid = () => { setInput('email', 'user@clinic.test'); setInput('password', 'a-strong-password'); };

describe('LoginPageNew — real login flow, zero act() warnings', () => {
  it('successful login: one request, auth established, one navigation, login page unmounts', async () => {
    signIn.mockResolvedValue({ status: 'OK', accessToken: 'tok', activeTenantId: 't-1' });
    fetchMe.mockResolvedValue({ userId: 'u-1', activeTenantId: 't-1', isPlatformOperator: false });

    mount();
    fillValid();
    await submitForm();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith('user@clinic.test', 'a-strong-password');
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(setAccessToken).toHaveBeenCalledWith('tok');
    // Navigated to "/" — the login form is gone and the panel route is shown.
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toMatch(/PANEL_HOME/);
  });

  it('a rapid double-submit issues exactly ONE sign-in request (single-flight)', async () => {
    let resolveSignIn;
    signIn.mockImplementation(() => new Promise((res) => { resolveSignIn = () => res({ status: 'OK', accessToken: 'tok', activeTenantId: 't-1' }); }));
    fetchMe.mockResolvedValue({ userId: 'u-1', activeTenantId: 't-1', isPlatformOperator: false });

    mount();
    fillValid();
    const form = host.querySelector('form');
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    // Only one request despite two submits.
    expect(signIn).toHaveBeenCalledTimes(1);
    // Finish the in-flight request cleanly.
    await act(async () => { resolveSignIn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); });
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('failed login: one error state, stays on the login page, no stale update', async () => {
    signIn.mockRejectedValue(new Error('bad credentials'));

    mount();
    fillValid();
    await submitForm();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(host.querySelector('form')).not.toBeNull(); // still on login
    expect(host.textContent).toMatch(/Sign-in failed/i);
  });

  it('network failure surfaces an error and remains on the login page', async () => {
    signIn.mockRejectedValue(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
    mount();
    fillValid();
    await submitForm();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(host.querySelector('form')).not.toBeNull();
  });

  it('an unfinished (MFA) outcome stays on login with a clear message', async () => {
    signIn.mockResolvedValue({ status: 'MFA_REQUIRED' });
    mount();
    fillValid();
    await submitForm();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(host.textContent).toMatch(/additional verification/i);
    expect(host.querySelector('form')).not.toBeNull();
  });

  // REGRESSION — staff login "not a member of an organization". Authentication
  // succeeds but the principal has no activeTenantId (no ACTIVE membership); the
  // login page must show the not-a-member message and stay put — never a blank
  // navigation or a crash.
  it('a staff account with no resolvable membership shows "not a member" and stays on login', async () => {
    signIn.mockResolvedValue({ status: 'OK', accessToken: 'tok', activeTenantId: null });
    fetchMe.mockResolvedValue({ userId: 'bcba-1', activeTenantId: null, isPlatformOperator: false });
    mount();
    fillValid();
    await submitForm();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
    expect(host.textContent).toMatch(/not a member of an organization/i);
    expect(host.querySelector('form')).not.toBeNull();
    expect(host.textContent).not.toMatch(/PANEL_HOME/);
  });

  it('does not submit when the form is empty (no request)', async () => {
    mount();
    await submitForm();
    expect(signIn).not.toHaveBeenCalled();
    expect(host.querySelector('form')).not.toBeNull();
  });
});
