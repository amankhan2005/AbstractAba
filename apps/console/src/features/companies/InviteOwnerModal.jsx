import { useState } from 'react';
import { Modal, useToast, Field, Icon } from '@/components';
import { useInviteOwner } from '@/api/queries';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Invite an owner for an existing company. Maps to the backend
 * POST /platform/organizations/:id/owner-invitations (email + fullName).
 */
export function InviteOwnerModal({ id, onClose }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const invite = useInviteOwner(id);
  const toast = useToast();
  const busy = invite.isPending;

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const next = {};
    if (fullName.trim().length < 2) next.fullName = 'Enter the owner’s full name.';
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address.';
    setErrors(next);
    setError(null);
    if (Object.keys(next).length) return;
    try {
      await invite.mutateAsync({ email: email.trim().toLowerCase(), fullName: fullName.trim() });
      toast.push(`Owner invitation sent to ${email.trim().toLowerCase()}.`);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error?.message ?? 'The invitation couldn’t be sent. Please try again.');
    }
  }

  return (
    <Modal
      title="Invite owner"
      description="The owner receives an email to create their account for this company."
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <button type="button" className="rxc-btn rxc-btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="rxc-invite-owner" className="rxc-btn rxc-btn--primary" disabled={busy}>
            {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : <Icon name="send" size={16} />}
            <span>{busy ? 'Sending…' : 'Send invitation'}</span>
          </button>
        </>
      }
    >
      <form id="rxc-invite-owner" className="rxc-form" onSubmit={submit} noValidate>
        {error ? <p className="form-error" role="alert"><Icon name="alertCircle" size={16} /><span>{error}</span></p> : null}
        <Field label="Full name" error={errors.fullName}>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jordan Lee" autoComplete="off" aria-invalid={errors.fullName ? 'true' : undefined} />
        </Field>
        <Field label="Email" error={errors.email}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jordan@company.com" autoComplete="off" aria-invalid={errors.email ? 'true' : undefined} />
        </Field>
      </form>
    </Modal>
  );
}
