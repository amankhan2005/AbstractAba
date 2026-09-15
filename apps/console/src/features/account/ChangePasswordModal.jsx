import { useState } from 'react';
import { Modal, useToast, Field, PasswordInput, Icon } from '@/components';
import { changePassword } from '@/api/client';

const MIN_LENGTH = 10;

/**
 * Change the signed-in operator's password. Calls POST /auth/change-password,
 * which verifies the current password server-side and enforces the password
 * policy. No password is placed in the URL, logs, or query cache.
 */
export function ChangePasswordModal({ onClose }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e) {
    e?.preventDefault?.();
    if (busy) return;
    setFormError(null);
    const next = {};
    if (!currentPassword) next.current = 'Enter your current password.';
    if (newPassword.length < MIN_LENGTH) next.new = `Use at least ${MIN_LENGTH} characters.`;
    else if (newPassword === currentPassword) next.new = 'Choose a password different from your current one.';
    if (!next.new && newPassword !== confirm) next.confirm = 'New password and confirmation do not match.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast.push('Your password has been changed.');
      onClose();
    } catch (err) {
      const data = err?.response?.data?.error;
      const fe = data?.details?.fieldErrors;
      if (fe?.currentPassword?.[0]) setErrors({ current: 'Current password is incorrect.' });
      else if (fe?.newPassword?.[0]) setErrors({ new: fe.newPassword[0] });
      else setFormError(data?.message ?? 'We couldn’t change your password. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const long = newPassword.length >= MIN_LENGTH;

  return (
    <Modal
      title="Change password"
      description="Use a strong password you don’t use anywhere else."
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <button type="button" className="rxc-btn rxc-btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="rxc-change-password" className="rxc-btn rxc-btn--primary" disabled={busy}>
            {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : null}
            <span>{busy ? 'Saving…' : 'Change password'}</span>
          </button>
        </>
      }
    >
      <form id="rxc-change-password" className="rxc-form" onSubmit={submit} noValidate>
        {formError ? <p className="form-error" role="alert">{formError}</p> : null}
        <Field label="Current password" error={errors.current}>
          <PasswordInput value={currentPassword} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" invalid={!!errors.current} />
        </Field>
        <Field label="New password" error={errors.new}>
          <PasswordInput value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" invalid={!!errors.new} />
        </Field>
        <p className={`rxc-rule${long ? ' is-met' : ''}`}>
          <Icon name={long ? 'checkCircle' : 'info'} size={15} />
          <span>At least {MIN_LENGTH} characters</span>
        </p>
        <Field label="Confirm new password" error={errors.confirm}>
          <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" invalid={!!errors.confirm} />
        </Field>
      </form>
    </Modal>
  );
}
