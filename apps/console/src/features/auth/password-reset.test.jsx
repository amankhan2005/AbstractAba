// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Super Admin password recovery UI (Pending #7, tests 1–3, 5, 8).
 * Drives the real console pages against a mocked shared API client; the backend
 * token security (single-use, expiry, hashing) is covered by the API suite's
 * password-reset tests. act()-clean: warnings fail the suite.
 */

const requestPasswordReset = vi.fn();
const resetPassword = vi.fn();
vi.mock('@/api/client', () => ({
  requestPasswordReset: (...a) => requestPasswordReset(...a),
  resetPassword: (...a) => resetPassword(...a),
}));

let consoleErrorSpy;
const actWarnings = () => consoleErrorSpy.mock.calls.filter((a) => /not wrapped in act/i.test(String(a[0] ?? '')));
let host; let root; let Pages;

beforeEach(async () => {
  consoleErrorSpy = vi.spyOn(console, 'error');
  Pages = await import('./PasswordResetPages.jsx');
  requestPasswordReset.mockReset();
  resetPassword.mockReset();
});
afterEach(() => {
  if (root) act(() => root.unmount()); if (host) host.remove(); root = undefined; host = undefined;
  const w = actWarnings(); consoleErrorSpy.mockRestore();
  expect(w, `act() warnings: ${JSON.stringify(w)}`).toHaveLength(0);
});

const mount = (ui, initial = '/') => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<MemoryRouter initialEntries={[initial]}>{ui}</MemoryRouter>));
};
const flush = async (n = 4) => { for (let i = 0; i < n; i += 1) await act(async () => { await Promise.resolve(); }); };
const setInput = (label, value) => {
  const span = [...host.querySelectorAll('label span')].find((s) => s.textContent === label);
  const input = span.parentElement.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  act(() => input.dispatchEvent(new Event('input', { bubbles: true })));
};
const clickText = async (re) => {
  const b = [...host.querySelectorAll('button')].find((x) => re.test(x.textContent));
  await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
};

describe('Super Admin forgot password', () => {
  it('renders, submits the email, and shows a non-enumerating confirmation', async () => {
    requestPasswordReset.mockResolvedValue(undefined);
    mount(<Pages.ForgotPasswordPage />);
    setInput('Email', 'operator@platform.test');
    await clickText(/Send reset link/);
    await flush();
    expect(requestPasswordReset).toHaveBeenCalledWith('operator@platform.test');
    expect(host.textContent).toMatch(/If an account exists/i);
  });

  it('still shows the same confirmation even if the request errors (no enumeration)', async () => {
    requestPasswordReset.mockRejectedValue(new Error('boom'));
    mount(<Pages.ForgotPasswordPage />);
    setInput('Email', 'unknown@nowhere.test');
    await clickText(/Send reset link/);
    await flush();
    expect(host.textContent).toMatch(/If an account exists/i);
  });
});

describe('Super Admin reset password', () => {
  it('sets a new password with the token and confirms success', async () => {
    resetPassword.mockResolvedValue(undefined);
    mount(<Routes><Route path="/reset-password/:token" element={<Pages.ResetPasswordPage />} /></Routes>, '/reset-password/tok-xyz');
    setInput('New password', 'a-strong-password-1');
    setInput('Confirm password', 'a-strong-password-1');
    await clickText(/Set new password/);
    await flush();
    expect(resetPassword).toHaveBeenCalledWith('tok-xyz', 'a-strong-password-1');
    expect(host.textContent).toMatch(/Password updated/i);
  });

  it('rejects a mismatch client-side without calling the API', async () => {
    mount(<Routes><Route path="/reset-password/:token" element={<Pages.ResetPasswordPage />} /></Routes>, '/reset-password/tok-xyz');
    setInput('New password', 'a-strong-password-1');
    setInput('Confirm password', 'different-password-9');
    await clickText(/Set new password/);
    await flush();
    expect(resetPassword).not.toHaveBeenCalled();
    expect(host.textContent).toMatch(/do not match/i);
  });
});
