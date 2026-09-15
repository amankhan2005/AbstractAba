import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { requestPasswordReset, resetPassword } from '@/api/client';
import { Button, Icon } from '@/ui';
import { BrandLogo } from '@/ui/BrandLogo.jsx';

function Shell({ children }) {
  return (
    <div className="rx-auth">
      <div className="rx-auth__card">
        <div className="rx-auth__brand"><BrandLogo size="md" /></div>
        {children}
      </div>
    </div>
  );
}

/**
 * Public "Forgot password?" page. Submitting always shows the same confirmation —
 * the backend never reveals whether an email exists (no account enumeration).
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: () => requestPasswordReset(email.trim()) });

  if (send.isSuccess) {
    return (
      <Shell>
        <div className="rx-auth__state">
          <Icon.CheckCircle size={28} />
          <h1>Check your email</h1>
          <p>If an account exists for that address, we&apos;ve sent a secure link to reset your password. It expires in one hour.</p>
          <a className="rx-link" href="/login">Back to sign in</a>
        </div>
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="rx-auth__head">
        <h1>Reset your password</h1>
        <p>Enter your email and we&apos;ll send you a secure link to set a new password.</p>
      </div>
      <form className="rx-auth__form" onSubmit={(e) => { e.preventDefault(); if (email.trim()) send.mutate(); }} noValidate>
        <div className="rx-input">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" placeholder="you@clinic.com"
            value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <Button type="submit" size="lg" block loading={send.isPending}>Send reset link</Button>
        <p className="rx-auth__meta" style={{ textAlign: 'center' }}><a className="rx-link" href="/login">Back to sign in</a></p>
      </form>
    </Shell>
  );
}

/**
 * Public reset page reached from the emailed link (/reset-password/:token).
 * Sets a new password by consuming the single-use token; the token is validated
 * server-side (hash + expiry + single use).
 */
export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localErr, setLocalErr] = useState('');
  const submit = useMutation({ mutationFn: () => resetPassword(token, password) });

  function onSubmit(e) {
    e.preventDefault();
    setLocalErr('');
    if (password.length < 10) { setLocalErr('Choose a password of at least 10 characters.'); return; }
    if (password !== confirm) { setLocalErr('The passwords do not match.'); return; }
    submit.mutate();
  }

  if (submit.isSuccess) {
    return (
      <Shell>
        <div className="rx-auth__state">
          <Icon.CheckCircle size={28} />
          <h1>Password updated</h1>
          <p>Your password has been reset. You can now sign in.</p>
          <Button size="lg" onClick={() => navigate('/login')}>Go to sign in</Button>
        </div>
      </Shell>
    );
  }

  const serverErr = submit.isError
    ? (submit.error?.response?.data?.error?.message ?? 'This reset link is invalid or has expired.')
    : '';
  return (
    <Shell>
      <div className="rx-auth__head">
        <h1>Choose a new password</h1>
        <p>Enter and confirm your new password below.</p>
      </div>
      <form className="rx-auth__form" onSubmit={onSubmit} noValidate>
        <div className="rx-input">
          <label htmlFor="pw">New password</label>
          <input id="pw" type="password" autoComplete="new-password" placeholder="At least 10 characters"
            value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div className="rx-input">
          <label htmlFor="pw2">Confirm password</label>
          <input id="pw2" type="password" autoComplete="new-password" placeholder="Re-enter your password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        {(localErr || serverErr) && <div className="rx-auth__error" role="alert"><Icon.Bell size={18} /> <span>{localErr || serverErr}</span></div>}
        <Button type="submit" size="lg" block loading={submit.isPending}>Set new password</Button>
        <p className="rx-auth__meta" style={{ textAlign: 'center' }}><a className="rx-link" href="/login">Back to sign in</a></p>
      </form>
    </Shell>
  );
}
