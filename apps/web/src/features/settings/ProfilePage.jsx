import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useReducedMotion } from 'framer-motion';
import { PageHeader, Card, Button, Icon, Field, TextInput, PasswordInput } from '@/ui';
import { useAuthStore } from '@/auth/store';
import { updateMyProfile, changePassword, fetchMe, fetchBranding } from '@/api/client';

const ROLE_LABEL = { bcba: 'BCBA', rbt: 'RBT', owner: 'Owner', org_admin: 'Company Admin', manager: 'Manager', scheduler: 'Scheduler', billing_staff: 'Billing', payroll_staff: 'Payroll', receptionist: 'Receptionist' };
const ROLE_DESCRIPTION = { bcba: 'Board Certified Behavior Analyst', rbt: 'Registered Behavior Technician' };

/**
 * Profile — the BCBA (and any signed-in user) manages their own display name and
 * password. Email is READ-ONLY: it is shown disabled and never sent to the
 * server (the update endpoint's schema rejects it). Identity is the token's, so
 * a user can only ever edit themselves. Password uses the existing secure
 * change-password endpoint; passwords are never displayed or returned.
 */
function splitName(fullName = '') {
  const parts = fullName.trim().split(/\s+/);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
}

export function ProfilePage() {
  const reduce = useReducedMotion();
  const principal = useAuthStore((s) => s.principal);
  const setState = useAuthStore.setState;
  const qc = useQueryClient();

  const user = principal?.user ?? {};
  const initial = splitName(user.fullName);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [nameOk, setNameOk] = useState(false);
  const [nameErr, setNameErr] = useState(null);

  const saveName = useMutation({
    mutationFn: () => updateMyProfile({ firstName: firstName.trim(), lastName: lastName.trim() }),
    onMutate: () => { setNameOk(false); setNameErr(null); },
    onSuccess: async () => {
      // Refresh the principal so the sidebar/greeting update without a reload.
      try {
        const me = await fetchMe();
        setState((s) => ({ ...s, principal: { ...s.principal, ...me } }));
      } catch { /* non-fatal: the save succeeded regardless */ }
      qc.invalidateQueries({ queryKey: ['org-branding'] });
      setNameOk(true);
    },
    onError: () => setNameErr('Could not save your name. Please try again.'),
  });

  const initials = ((firstName[0] || '') + (lastName[0] || '')).toUpperCase() || 'U';
  const nameValid = firstName.trim() && lastName.trim();
  // Role and organization come from the session and the branding the shell has
  // already loaded (same query key — no extra request).
  const roleKey = (principal?.roles ?? []).find((r) => ROLE_LABEL[r]);
  const branding = useQuery({ queryKey: ['org-branding'], queryFn: fetchBranding, staleTime: 60_000 });
  const savedName = [initial.firstName, initial.lastName].filter(Boolean).join(' ');

  return (
    <div className="rx-profile">
      <PageHeader eyebrow="Account" title="Profile" subtitle="Your personal information and sign-in security." />

      <Card className="rx-profilehead">
        <div className="rx-profilehead__row">
          <div className="rx-avatar rx-profilehead__avatar" aria-hidden="true">{initials}</div>
          <div className="rx-profilehead__who">
            <div className="rx-profilehead__name">{savedName || user.email || '—'}</div>
            <div className="rx-profilehead__meta">{user.email}</div>
          </div>
          <dl className="rx-profilehead__facts">
            {roleKey && <div><dt>Role</dt><dd><span className="rx-profilehead__role">{ROLE_LABEL[roleKey]}</span>{ROLE_DESCRIPTION[roleKey] && <span className="rx-profilehead__roledesc">{ROLE_DESCRIPTION[roleKey]}</span>}</dd></div>}
            {branding.data?.name && <div><dt>Organization</dt><dd>{branding.data.name}</dd></div>}
          </dl>
        </div>
      </Card>

      <div className="rx-profile__grid">
        <Card title="Personal information" hint="Your name appears in the sidebar and on your sessions">
          <Field label="First name"><TextInput value={firstName} onChange={(e) => setFirstName(e.target?.value ?? e)} /></Field>
          <Field label="Last name"><TextInput value={lastName} onChange={(e) => setLastName(e.target?.value ?? e)} /></Field>
          <Field label="Email" hint="Email cannot be changed.">
            <TextInput value={user.email || ''} onChange={() => {}} disabled aria-readonly="true" />
          </Field>
          {nameErr && <div role="alert" className="rx-formfield__err">{nameErr}</div>}
          {nameOk && <div className="rx-formfield__ok" role="status">Saved.</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <Button variant="ghost" onClick={() => { setFirstName(initial.firstName); setLastName(initial.lastName); setNameErr(null); setNameOk(false); }}>Reset</Button>
            <Button icon={Icon.Check} onClick={() => saveName.mutate()} loading={saveName.isPending} disabled={!nameValid}>Save changes</Button>
          </div>
        </Card>

        <PasswordCard reduce={reduce} />
      </div>
    </div>
  );
}

function PasswordCard() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(null);

  const change = useMutation({
    mutationFn: () => changePassword({ currentPassword: cur, newPassword: next }),
    onMutate: () => { setOk(false); setErr(null); },
    onSuccess: () => { setOk(true); setCur(''); setNext(''); setConfirm(''); },
    onError: (e) => setErr(e?.response?.data?.error?.message || 'Could not change your password.'),
  });

  const mismatch = next && confirm && next !== confirm;
  const canSubmit = cur && next && confirm && !mismatch;

  return (
    <Card title="Password" hint="Choose a password you don’t use elsewhere">
      <Field label="Current password" htmlFor="profile-current-password"><PasswordInput id="profile-current-password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target?.value ?? e)} /></Field>
      <Field label="New password" htmlFor="profile-new-password"><PasswordInput id="profile-new-password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target?.value ?? e)} /></Field>
      <Field label="Confirm new password" htmlFor="profile-confirm-password" error={mismatch ? 'Passwords do not match.' : undefined}>
        <PasswordInput id="profile-confirm-password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target?.value ?? e)} error={Boolean(mismatch)} />
      </Field>
      {err && <div role="alert" className="rx-formfield__err">{err}</div>}
      {ok && <div className="rx-formfield__ok" role="status">Password changed.</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <Button icon={Icon.Shield} onClick={() => change.mutate()} loading={change.isPending} disabled={!canSubmit}>Change password</Button>
      </div>
    </Card>
  );
}

export default ProfilePage;
