import { useState } from 'react';
import { motion } from 'framer-motion';
import { Modal, useToast, Field, Icon } from '@/components';
import { useInviteCompany } from '@/api/queries';
import { formatPersonName } from '@/lib/format';

/**
 * Invite Company — the single company-invitation flow (used by the Dashboard,
 * Companies and Invitations pages).
 *
 * Company → Owner → Review → Send. The Super Admin enters only human
 * information: the company name and the owner's name + email. The backend
 * invitation endpoint accepts exactly this ({ companyName, contactName, email }).
 * All technical organization fields (slug, legal name, country, timezone) are
 * NOT invented here — the owner supplies and the backend validates them during
 * onboarding, so nothing is defaulted unsafely and no validation is weakened.
 */
const EMPTY = { companyName: '', ownerFirst: '', ownerLast: '', ownerEmail: '' };
const STEPS = ['Company', 'Owner', 'Review'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const fade = { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.18 } };

/** Pure mapping from the human form to the backend invite contract. Exported
 *  for tests: contactName is the owner's full name, email is normalized. */
export function buildInvitePayload(form) {
  return {
    companyName: form.companyName.trim(),
    contactName: `${form.ownerFirst.trim()} ${form.ownerLast.trim()}`.trim(),
    email: form.ownerEmail.trim().toLowerCase(),
  };
}

export function InviteCompanyWizard({ onClose }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [sent, setSent] = useState(null); // the email we sent to, once done
  const invite = useInviteCompany();
  const toast = useToast();
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const validateStep = (s) => {
    const err = {};
    if (s === 0 && form.companyName.trim().length < 2) err.companyName = 'Enter the company name (at least 2 characters).';
    if (s === 1) {
      if (form.ownerFirst.trim().length < 1) err.ownerFirst = 'Enter the owner’s first name.';
      if (form.ownerLast.trim().length < 1) err.ownerLast = 'Enter the owner’s last name.';
      if (!EMAIL_RE.test(form.ownerEmail.trim())) err.ownerEmail = 'Enter a valid email address.';
    }
    setErrors(err);
    return Object.keys(err).length === 0;
  };

  const next = (e) => { e?.preventDefault?.(); if (validateStep(step)) setStep((s) => s + 1); };
  const back = () => { setSubmitError(null); setStep((s) => Math.max(0, s - 1)); };
  const busy = invite.isPending;

  const send = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setSubmitError(null);
    try {
      await invite.mutateAsync(buildInvitePayload(form));
      setSent(form.ownerEmail.trim().toLowerCase());
      toast.push('Invitation sent.');
    } catch (err) {
      // Never fake success — surface a real failure and keep the data to retry.
      setSubmitError(err?.response?.data?.error?.message ?? 'We couldn’t send the invitation. Please try again.');
    }
  };

  if (sent) {
    return (
      <Modal title="Invitation sent" onClose={onClose}
        footer={<>
          <button type="button" className="rxc-btn rxc-btn--secondary" onClick={() => { setForm(EMPTY); setStep(0); setSent(null); }}>Invite another company</button>
          <button type="button" className="rxc-btn rxc-btn--primary" onClick={onClose}>Done</button>
        </>}>
        <motion.div {...fade} className="rxc-success">
          <span className="rxc-success__icon"><Icon name="send" size={22} /></span>
          <p>An invitation has been sent to <strong>{sent}</strong>.</p>
          <p className="rxc-muted" style={{ fontSize: '.84rem' }}>They’ll receive a secure link to complete their company setup. You can resend or revoke it from Invitations.</p>
        </motion.div>
      </Modal>
    );
  }

  const footer = (
    <>
      <span className="modal-foot__start">Step {step + 1} of {STEPS.length}</span>
      <button type="button" className="rxc-btn rxc-btn--secondary" onClick={step === 0 ? onClose : back} disabled={busy}>{step === 0 ? 'Cancel' : 'Back'}</button>
      {step < 2 ? (
        <button type="submit" form="rxc-invite-company" className="rxc-btn rxc-btn--primary">Continue</button>
      ) : (
        <button type="submit" form="rxc-invite-company" className="rxc-btn rxc-btn--primary" disabled={busy}>
          {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : <Icon name="send" size={16} />}
          <span>{busy ? 'Sending…' : 'Send invitation'}</span>
        </button>
      )}
    </>
  );

  const contactName = formatPersonName(`${form.ownerFirst} ${form.ownerLast}`.trim());

  return (
    <Modal title="Invite company" description="The owner receives a secure email link to set up their company." onClose={onClose} footer={footer} closeDisabled={busy}>
      <ol className="rxc-steps" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li key={label} className={`rxc-step${i === step ? ' is-current' : ''}${i < step ? ' is-done' : ''}`} aria-current={i === step ? 'step' : undefined}>
            {label}
          </li>
        ))}
      </ol>

      <form id="rxc-invite-company" onSubmit={step < 2 ? next : send} noValidate>
        <motion.div key={step} {...fade} className="rxc-form">
          {step === 0 && (
            <Field label="Company name" error={errors.companyName} hint="As the company is commonly known. The owner confirms legal details during setup.">
              <input value={form.companyName} onChange={set('companyName')} placeholder="Bright Path Behavioral Health" autoFocus aria-invalid={errors.companyName ? 'true' : undefined} />
            </Field>
          )}
          {step === 1 && (
            <>
              <div className="rxc-form-grid">
                <Field label="Owner first name" error={errors.ownerFirst}>
                  <input value={form.ownerFirst} onChange={set('ownerFirst')} autoComplete="off" autoFocus aria-invalid={errors.ownerFirst ? 'true' : undefined} />
                </Field>
                <Field label="Owner last name" error={errors.ownerLast}>
                  <input value={form.ownerLast} onChange={set('ownerLast')} autoComplete="off" aria-invalid={errors.ownerLast ? 'true' : undefined} />
                </Field>
              </div>
              <Field label="Owner email" error={errors.ownerEmail} hint="The invitation link is sent to this address.">
                <input type="email" value={form.ownerEmail} onChange={set('ownerEmail')} placeholder="owner@company.com" autoComplete="off" aria-invalid={errors.ownerEmail ? 'true' : undefined} />
              </Field>
            </>
          )}
          {step === 2 && (
            <>
              <div className="rxc-review">
                <div className="rxc-review__row"><span>Company</span><strong>{form.companyName.trim()}</strong></div>
                <div className="rxc-review__row"><span>Owner</span><strong>{contactName || '—'}</strong></div>
                <div className="rxc-review__row"><span>Email</span><strong>{form.ownerEmail.trim().toLowerCase()}</strong></div>
              </div>
              <p className="rxc-alert rxc-alert--info"><Icon name="info" size={16} /><span>The link expires if it isn’t used. You can resend it from Invitations.</span></p>
              {submitError ? <p className="form-error" role="alert"><Icon name="alertCircle" size={16} /><span>{submitError}</span></p> : null}
            </>
          )}
        </motion.div>
      </form>
    </Modal>
  );
}

export default InviteCompanyWizard;
