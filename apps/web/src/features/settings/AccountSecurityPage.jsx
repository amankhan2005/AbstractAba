import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { changePassword } from '@/api/client';
import { useAuthStore } from '@/auth/store';
import { PageHeader, Card, Button } from '@/ui';

/**
 * Account security — available to EVERY authenticated role (Company/Admin, BCBA,
 * RBT). Self-service change password over the existing authenticated endpoint;
 * the current password is verified server-side and the new one is hashed. No
 * password is ever shown, logged, or returned.
 *
 * Forced first-login change: a staff member signing in with a temporary password
 * is routed here by RequireAuth (mustChangePassword). After a successful change
 * the principal is refreshed (clearing the flag) and they proceed into the panel.
 */
export function AccountSecurityPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const forced = location.state?.forcedPasswordChange === true;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localErr, setLocalErr] = useState('');
  const save = useMutation({
    mutationFn: () => changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: async () => {
      setCurrent(''); setNext(''); setConfirm('');
      if (forced) {
        // Refresh the principal so the mustChangePassword gate clears, then enter the panel.
        await bootstrap();
        navigate('/', { replace: true });
      }
    },
  });
  function submit(e) {
    e.preventDefault();
    setLocalErr('');
    if (next.length < 10) { setLocalErr('New password must be at least 10 characters.'); return; }
    if (next !== confirm) { setLocalErr('The new passwords do not match.'); return; }
    save.mutate();
  }
  const serverErr = save.isError ? (save.error?.response?.data?.error?.message ?? 'Could not change your password.') : '';
  return (
    <>
      <PageHeader title="Account security" subtitle="Manage your own sign-in credentials." />
      <Card title="Change password" hint={forced ? 'Set a new password to finish signing in' : 'For your own account'}>
        {forced && (
          <p className="muted" style={{ marginTop: 0 }}>
            You signed in with a temporary password. Choose a new password to continue.
          </p>
        )}
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 380 }}>
          <input className="input" type="password" autoComplete="current-password" placeholder={forced ? 'Temporary password' : 'Current password'} value={current} onChange={(e) => setCurrent(e.target.value)} required />
          <input className="input" type="password" autoComplete="new-password" placeholder="New password (min 10 chars)" value={next} onChange={(e) => setNext(e.target.value)} required />
          <input className="input" type="password" autoComplete="new-password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          {(localErr || serverErr) && <p className="rx-formfield__err">{localErr || serverErr}</p>}
          {save.isSuccess && !forced && <p className="muted">Password updated.</p>}
          <Button type="submit" loading={save.isPending}>Update password</Button>
        </form>
      </Card>
    </>
  );
}

export default AccountSecurityPage;
