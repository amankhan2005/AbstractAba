import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { requestPasswordReset, resetPassword } from '@/api/client';
import { Field, Icon, PasswordInput } from '@/components';
import { AuthLayout } from './AuthLayout';

/**
 * Super Admin (Platform Console) password recovery. Uses the SAME shared backend
 * endpoints as the tenant app (/auth/forgot-password, /auth/reset-password) —
 * no separate auth or email system. The forgot step is account-enumeration safe:
 * it always shows the same confirmation whether or not the email exists.
 */
const MIN_LENGTH = 10;

function BackToSignIn() {
  return (
    <p className="rxc-auth__foot">
      <Link to="/login" className="rxc-link-btn"><Icon name="arrowLeft" size={15} />Back to sign in</Link>
    </p>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setError('Enter a valid email address.'); return; }
    setError('');
    setBusy(true);
    try {
      await requestPasswordReset(email.trim());
    } catch {
      // Deliberately ignored: never reveal delivery/account state.
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  if (sent) {
    return (
      <AuthLayout title="Account recovery" lead="Securely reset the password for your Abstract ABA Platform Console account.">
        <span className="rxc-auth__icon rxc-tone--green"><Icon name="mail" size={22} /></span>
        <h2 className="rxc-auth__title">Check your email</h2>
        <p className="rxc-auth__sub">If an account exists for that address, we&apos;ve sent password reset instructions. The link expires in one hour.</p>
        <BackToSignIn />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Account recovery" lead="Securely reset the password for your Abstract ABA Platform Console account.">
      <span className="rxc-auth__icon rxc-tone--blue"><Icon name="key" size={22} /></span>
      <h2 className="rxc-auth__title">Reset your password</h2>
      <p className="rxc-auth__sub">Enter your email and we&apos;ll send a secure link to reset your password.</p>
      <form className="rxc-auth__form" onSubmit={submit} noValidate>
        <Field label="Email" error={error}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="username" placeholder="you@company.com" required autoFocus aria-invalid={error ? 'true' : undefined} />
        </Field>
        <button type="submit" className="rxc-btn rxc-btn--primary rxc-btn--block rxc-auth__submit" disabled={busy}>
          {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : null}
          <span>{busy ? 'Sending…' : 'Send reset link'}</span>
        </button>
      </form>
      <BackToSignIn />
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (password.length < MIN_LENGTH) { setError(`Choose a password of at least ${MIN_LENGTH} characters.`); return; }
    if (password !== confirm) { setError('The passwords do not match.'); return; }
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err?.response?.data?.error?.message ?? 'This reset link is invalid or has expired.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthLayout title="Account recovery" lead="Securely reset the password for your Abstract ABA Platform Console account.">
        <span className="rxc-auth__icon rxc-tone--green"><Icon name="checkCircle" size={22} /></span>
        <h2 className="rxc-auth__title">Password updated</h2>
        <p className="rxc-auth__sub">Your password has been reset. You can now sign in with your new password.</p>
        <div className="rxc-auth__form">
          <button type="button" className="rxc-btn rxc-btn--primary rxc-btn--block rxc-auth__submit" onClick={() => navigate('/login')}>Go to sign in</button>
        </div>
      </AuthLayout>
    );
  }

  const long = password.length >= MIN_LENGTH;

  return (
    <AuthLayout title="Account recovery" lead="Securely reset the password for your Abstract ABA Platform Console account.">
      <span className="rxc-auth__icon rxc-tone--blue"><Icon name="lock" size={22} /></span>
      <h2 className="rxc-auth__title">Choose a new password</h2>
      <p className="rxc-auth__sub">Enter and confirm your new password below.</p>
      <form className="rxc-auth__form" onSubmit={submit} noValidate>
        {error ? <p className="form-error" role="alert"><Icon name="alertCircle" size={16} /><span>{error}</span></p> : null}
        <Field label="New password">
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={`At least ${MIN_LENGTH} characters`} autoFocus />
        </Field>
        <p className={`rxc-rule${long ? ' is-met' : ''}`}>
          <Icon name={long ? 'checkCircle' : 'info'} size={15} /><span>At least {MIN_LENGTH} characters</span>
        </p>
        <Field label="Confirm password">
          <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" placeholder="Re-enter your password" />
        </Field>
        <button type="submit" className="rxc-btn rxc-btn--primary rxc-btn--block rxc-auth__submit" disabled={busy}>
          {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : null}
          <span>{busy ? 'Saving…' : 'Set new password'}</span>
        </button>
      </form>
      <BackToSignIn />
    </AuthLayout>
  );
}
