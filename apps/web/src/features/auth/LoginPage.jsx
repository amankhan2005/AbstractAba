import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/auth/store';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * Tenant sign-in. Uses the real authentication endpoint; on success the store
 * confirms the principal is an organization member before granting access.
 * Supports show/hide password and remember-me (persists the refresh token so the
 * session survives a browser restart).
 */
export function LoginPage() {
  const status = useAuthStore((state) => state.status);
  const error = useAuthStore((state) => state.error);
  const signIn = useAuthStore((state) => state.signIn);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  // Defaults to true: a session should survive a page refresh without the
  // user having to opt in every time. They can still uncheck it for a
  // shared/public machine.
  const [remember, setRemember] = useState(true);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const submit = (event) => {
    event.preventDefault();
    void signIn(email, password, remember);
  };

  return (
    <div className="login">
      <form className="ui-card login__card" onSubmit={submit}>
        <h1>{PLATFORM_BRAND.productName}</h1>
        <p className="muted">Sign in to your organization</p>

        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }}
            autoComplete="username" placeholder="you@organization.com" required />
        </label>

        <label className="field">
          <span>Password</span>
          <div className="input-affix">
            <input type={show ? 'text' : 'password'} value={password} onChange={(e) => { setPassword(e.target.value); }}
              autoComplete="current-password" placeholder="••••••••" required />
            <button type="button" className="input-affix__btn" onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>

        <label className="checkbox-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Remember me</span>
        </label>

        {error !== null ? <p className="form-error" role="alert">{error}</p> : null}

        <button type="submit" className="ui-button ui-button--block" disabled={status === 'authenticating'}>
          {status === 'authenticating' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
