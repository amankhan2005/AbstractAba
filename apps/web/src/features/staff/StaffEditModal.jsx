import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateStaff, adminResetMemberPassword } from '@/api/client';
import { Modal, Confirm, Field, TextInput, DateInput, Select, Button, Badge, Icon } from '@/ui';
import { useToast } from '@/components';
import { formatFullName } from '@/lib/format';

// The staff status model is ACTIVE | INACTIVE (STAFF_STATUS); the API rejects anything else.
const STATUS_OPTS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
];
// Optional text fields: a cleared value is sent as null so it is actually removed.
const OPTIONAL_TEXT = ['middleName', 'title'];

function initials(a = '', b = '') { return ((a[0] || '') + (b[0] || '')).toUpperCase() || '—'; }

/**
 * Premium staff editor, presented in the design-system Modal. Edits only the
 * fields the backend permits (name, title, discipline, employee #, status,
 * start date); email is create-time identity and shown read-only. No password
 * is ever displayed — an admin can trigger a secure reset LINK, and never sees
 * or sets a password. Business behavior is unchanged; this is the same
 * updateStaff / reset endpoints in a better shell.
 */
export function StaffEditModal({ staff, staffId, canManage, onClose, onSaved }) {
  // Pay is shown/edited only when the API returned it to this viewer.
  const payVisible = Object.prototype.hasOwnProperty.call(staff, 'hourlyPayRate');
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    firstName: staff.firstName ?? '',
    middleName: staff.middleName ?? '',
    lastName: staff.lastName ?? '',
    email: staff.email ?? staff.loginEmail ?? '',
    title: staff.title ?? '',
    hourlyPayRate: staff.hourlyPayRate ?? '',
    status: staff.status ?? 'ACTIVE',
    startDate: staff.startDate ? String(staff.startDate).slice(0, 10) : '',
  });
  const [err, setErr] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      // Only CHANGED fields are sent, so an unchanged pay rate never appends a
      // duplicate effective-dated PayRate row.
      const body = {};
      const original = (k) => (staff[k] == null ? '' : String(k === 'startDate' ? String(staff[k]).slice(0, 10) : staff[k]));
      for (const k of ['firstName', 'middleName', 'lastName', 'title', 'status', 'startDate']) {
        const next = typeof form[k] === 'string' ? form[k].trim() : form[k];
        if (String(next ?? '') === original(k)) continue;
        if (next === '' || next == null) {
          if (OPTIONAL_TEXT.includes(k)) body[k] = null;
          continue;
        }
        body[k] = next;
      }
      // Email is the canonical login identity on the User row — send it only
      // when the admin actually changed it. Employee ID is server-managed and
      // never sent from the client (spec §6/§7).
      const nextEmail = String(form.email).trim().toLowerCase();
      if (nextEmail && nextEmail !== String(staff.email ?? staff.loginEmail ?? '').trim().toLowerCase()) body.email = nextEmail;
      // Hourly Pay Rate is routed to the staff PayRate model by the API (spec Module 1).
      const rate = String(form.hourlyPayRate).trim();
      if (payVisible && rate !== '' && Number(rate) !== Number(staff.hourlyPayRate)) body.hourlyPayRate = Number(rate);
      if (Object.keys(body).length === 0) return Promise.resolve(null);
      return updateStaff(staffId, body, staff.version);
    },
    onSuccess: async (result) => {
      if (result) {
        // Prefix key: refreshes this profile AND the Staff list.
        await qc.invalidateQueries({ queryKey: ['staff'] });
        toast.push('Staff details saved.');
      }
      onSaved?.(result);
      onClose();
    },
    onError: (e) => setErr(e?.response?.data?.error?.message ?? 'Could not save changes. Please try again.'),
  });

  const reset = useMutation({
    mutationFn: () => adminResetMemberPassword(staff.membershipId),
    onSuccess: () => { setConfirmReset(false); toast.push('A secure reset link has been sent to the staff member.'); },
    onError: (e) => { setConfirmReset(false); toast.push(e?.response?.data?.error?.message ?? 'Could not send the reset link.', 'negative'); },
  });

  function submit() {
    if (!form.firstName.trim() || !form.lastName.trim()) { setErr('First and last name are required.'); return; }
    setErr('');
    save.mutate();
  }

  const role = (staff.roleKeys && staff.roleKeys[0] ? String(staff.roleKeys[0]).toUpperCase() : null) || staff.title || 'Staff';

  return (
    <>
      <Modal open onClose={onClose} size="lg" title="Edit staff member"
        description="Update employment details. Employee ID is assigned automatically; passwords are never shown."
        footer={<>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button icon={Icon.Check} loading={save.isPending} onClick={submit} disabled={!canManage}>Save changes</Button>
        </>}>

        {/* Header: avatar + name + role badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
          <div className="rx-avatar rx-avatar--lg" aria-hidden="true">{initials(form.firstName, form.lastName)}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>
              {formatFullName({ firstName: form.firstName, middleName: form.middleName, lastName: form.lastName }) || 'New staff member'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <Badge tone="accent">{role}</Badge>
              {staff.employeeNumber ? <span className="rx-row__meta">#{staff.employeeNumber}</span> : null}
            </div>
          </div>
        </div>

        {/* Identity */}
        <div className="rx-formsection">
          <div className="rx-formsection__title">Identity</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="First name" required><TextInput value={form.firstName} onChange={set('firstName')} /></Field>
            <Field label="Middle name"><TextInput value={form.middleName} onChange={set('middleName')} /></Field>
            <Field label="Last name" required><TextInput value={form.lastName} onChange={set('lastName')} /></Field>
          </div>
          <Field label="Email" hint="Login identity — updating it changes the staff member's sign-in email">
            <TextInput type="email" value={form.email} onChange={set('email')} disabled={!canManage} />
          </Field>
        </div>

        {/* Employment */}
        <div className="rx-formsection">
          <div className="rx-formsection__title">Employment</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Title"><TextInput value={form.title} onChange={set('title')} placeholder="e.g. Lead Clinician" /></Field>
            {payVisible && <Field label="Hourly pay rate" hint="Staff compensation, used for payroll"><TextInput type="number" min="0" step="0.01" value={form.hourlyPayRate} onChange={set('hourlyPayRate')} /></Field>}
            <Field label="Employee ID" hint="Automatically assigned"><TextInput value={staff.employeeNumber ?? '—'} disabled readOnly /></Field>
            <Field label="Start date" hint="MM/DD/YYYY"><DateInput value={form.startDate} onChange={set('startDate')} aria-label="Start date" /></Field>
            <Field label="Status"><Select value={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v }))} options={STATUS_OPTS} searchable={false} /></Field>
          </div>
        </div>

        {/* Security — reset link only, never a password */}
        {canManage && staff.membershipId ? (
          <div className="rx-formsection">
            <div className="rx-formsection__title">Security</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span className="rx-row__meta">Send this staff member a secure link to set a new password. You never see their password.</span>
              <Button variant="ghost" icon={Icon.Shield} onClick={() => setConfirmReset(true)} loading={reset.isPending}>Reset password</Button>
            </div>
          </div>
        ) : null}

        {err && <p className="rx-formfield__err" role="alert" style={{ marginTop: 4 }}>{err}</p>}
      </Modal>

      {confirmReset && (
        <Confirm
          open
          title="Reset password?"
          message="A secure reset link will be sent to the staff member's email. You will not see or set their password."
          confirmLabel="Send reset link"
          busy={reset.isPending}
          onConfirm={() => reset.mutate()}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </>
  );
}

export default StaffEditModal;
