import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { previewMemberInvitation, acceptMemberInvitation } from '@/api/client';
import { Button, Icon } from '@/ui';
import { BrandLogo } from '@/ui/BrandLogo.jsx';

/**
 * Staff account activation — the one anonymous page a new BCBA/RBT lands on from
 * their invitation link (/invitations/:token). It previews the invitation
 * (server validates the token), lets them set a password, then calls the
 * EXISTING accept endpoint which hashes the password and activates the
 * membership. No role is ever chosen here — the backend membership role is
 * authoritative. On success it points them at the existing /login page; this is
 * not a second auth system.
 *
 * Every state is explicit (loading / invalid-or-expired link / mismatch /
 * weak-password from the server / submitting / done). Nothing renders undefined.
 */
export function StaffActivationPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [localErr, setLocalErr] = useState('');

  const preview = useQuery({
    queryKey: ['member-invitation', token],
    queryFn: () => previewMemberInvitation(token),
    enabled: Boolean(token),
    retry: false,
  });

  const activate = useMutation({
    mutationFn: () => acceptMemberInvitation(token, { password }),
    onError: () => { /* surfaced below from activate.error */ },
  });

  function submit(e) {
    e.preventDefault();
    setLocalErr('');
    if (password.length < 8) { setLocalErr('Choose a password of at least 8 characters.'); return; }
    if (password !== confirm) { setLocalErr('The passwords do not match.'); return; }
    activate.mutate();
  }

  const serverErr = activate.isError
    ? (activate.error?.response?.data?.error?.message ?? 'We could not activate your account. Please try again.')
    : '';

  // Invalid / expired / already-used token — one clear, non-technical state.
  if (preview.isError) {
    const msg = preview.error?.response?.data?.error?.message
      ?? 'This activation link is no longer valid. Please ask your administrator to resend the invitation.';
    return (
      <Shell>
        <div className="rx-auth__state">
          <Icon.Shield size={28} />
          <h1>Activation link not valid</h1>
          <p>{msg}</p>
          <Button variant="ghost" onClick={() => navigate('/login')}>Go to sign in</Button>
        </div>
      </Shell>
    );
  }

  if (preview.isLoading) {
    return <Shell><div className="rx-auth__state"><span className="rx-spinner" /><p>Checking your invitation…</p></div></Shell>;
  }

  if (activate.isSuccess) {
    return (
      <Shell>
        <div className="rx-auth__state">
          <Icon.CheckCircle size={28} />
          <h1>Account activated</h1>
          <p>Your password is set. You can now sign in.</p>
          <Button size="lg" onClick={() => navigate('/login')}>Go to sign in</Button>
        </div>
      </Shell>
    );
  }

  const d = preview.data ?? {};
  return (
    <Shell>
      <div className="rx-auth__head">
        <h1>Activate your account</h1>
        <p>{d.organizationTradingName ? `Set a password for your ${d.organizationTradingName} account.` : 'Set a password to finish setting up your account.'}</p>
        {d.email && <p className="rx-auth__meta">Signing in as <strong>{d.email}</strong></p>}
      </div>

      <form onSubmit={submit} className="rx-auth__form" noValidate>
        <div className="rx-input">
          <label htmlFor="pw">New password</label>
          <div className="rx-input__wrap">
            <input id="pw" type={show ? 'text' : 'password'} autoComplete="new-password" placeholder="At least 8 characters"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button type="button" className="rx-input__toggle" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <Icon.EyeOff size={18} /> : <Icon.Eye size={18} />}
            </button>
          </div>
        </div>
        <div className="rx-input">
          <label htmlFor="pw2">Confirm password</label>
          <input id="pw2" type={show ? 'text' : 'password'} autoComplete="new-password" placeholder="Re-enter your password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>

        {(localErr || serverErr) && (
          <div className="rx-auth__error" role="alert"><Icon.Bell size={18} /> <span>{localErr || serverErr}</span></div>
        )}

        <Button type="submit" size="lg" block loading={activate.isPending}>Activate account</Button>
        <p className="rx-auth__meta" style={{ textAlign: 'center' }}>Already activated? <a className="rx-link" href="/login">Sign in</a></p>
      </form>
    </Shell>
  );
}

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

export default StaffActivationPage;
