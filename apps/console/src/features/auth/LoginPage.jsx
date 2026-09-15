import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/auth/store';
import { Field, Icon, PasswordInput } from '@/components';
import { AuthLayout } from './AuthLayout';

/**
 * Operator sign-in. Uses the real authentication endpoint; on success the store
 * confirms the principal is a platform operator before granting access. Supports
 * show/hide password.
 */
export function LoginPage() {
  const status = useAuthStore((state) => state.status);
  const error = useAuthStore((state) => state.error);
  const signIn = useAuthStore((state) => state.signIn);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const busy = status === 'authenticating';
  const submit = (event) => {
    event.preventDefault();
    if (busy) return;
    // Session persistence is decided server-side (httpOnly refresh cookie).
    void signIn(email.trim(), password, true);
  };

  return (
    <AuthLayout
      title="Sign in to your account"
      lead="The Abstract ABA Platform Console — onboard companies, manage subscriptions and billing, and maintain the insurance catalog."
      cardTitle="Super Admin sign-in"
      cardSubtitle="For platform administrators only."
      cardIcon="lock"
    >
      <form className="rxc-auth__form" onSubmit={submit}>
        {error !== null ? (
          <p className="form-error" role="alert"><Icon name="alertCircle" size={16} /><span>{error}</span></p>
        ) : null}

        <Field label="Email">
          <input type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="username" placeholder="you@company.com" required autoFocus />
        </Field>

        <Field label="Password">
          <PasswordInput id="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>

        <div className="rxc-auth__row rxc-auth__row--end">
          <Link to="/forgot-password" className="rxc-link-btn">Forgot password?</Link>
        </div>

        <button type="submit" className="rxc-btn rxc-btn--primary rxc-btn--block rxc-auth__submit" disabled={busy} aria-busy={busy ? 'true' : undefined}>
          {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : null}
          <span>{busy ? 'Signing in…' : 'Sign in'}</span>
          {busy ? null : <Icon name="arrowRight" size={18} />}
        </button>
      </form>

      <p className="rxc-auth__assure"><Icon name="shield" size={14} /><span>Access is restricted to platform operators.</span></p>
    </AuthLayout>
  );
}
