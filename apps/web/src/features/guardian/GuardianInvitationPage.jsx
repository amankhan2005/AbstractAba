import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { resolveGuardianInvitation, submitGuardianInvitation } from '@/api/client';

/**
 * The anonymous guardian page — blueprint §2.6 / §6.2.
 *
 * This is NOT a portal. §2.6 excludes a family portal from this version, and
 * §5.1 records that the underlying need is met without one. It is a single
 * form behind a one-time link: a family fills it in once and the link closes.
 *
 * Rendered OUTSIDE the authenticated shell — no sidebar, no navigation, no
 * account. A guardian who lands here has no session and should never be shown
 * a way to look for one.
 *
 * Every failure — unknown link, expired, revoked, already used — renders the
 * SAME message, because the API deliberately does not distinguish them and the
 * interface must not either.
 */
export function GuardianInvitationPage() {
  const { token } = useParams();
  const [form, setForm] = useState({
    phone: '', email: '', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '',
  });

  const invitation = useQuery({
    queryKey: ['guardian-invitation', token],
    queryFn: () => resolveGuardianInvitation(token),
    enabled: Boolean(token),
    // A one-time link should not be silently re-fetched behind the family's
    // back; and a failed link never becomes valid by trying again.
    retry: false,
    refetchOnWindowFocus: false,
  });

  const submit = useMutation({
    mutationFn: () => submitGuardianInvitation(token, filled(form)),
  });

  if (invitation.isPending) {
    return <Shell><p className="guardian__muted">Loading…</p></Shell>;
  }

  if (invitation.isError) {
    return (
      <Shell>
        <h1 className="guardian__title">This link is no longer valid</h1>
        <p className="guardian__body">
          It may have already been used, or it may have expired. Please contact your clinic
          and ask them to send you a new one.
        </p>
      </Shell>
    );
  }

  if (submit.isSuccess) {
    return (
      <Shell organizationName={invitation.data.organizationName}>
        <h1 className="guardian__title">Thank you</h1>
        <p className="guardian__body">
          Your details have been sent to {invitation.data.organizationName}. There is nothing
          else you need to do — you can close this page.
        </p>
      </Shell>
    );
  }

  const { organizationName, childFirstName } = invitation.data;
  const nothingFilled = Object.keys(filled(form)).length === 0;

  return (
    <Shell organizationName={organizationName}>
      <h1 className="guardian__title">A few details for {childFirstName}</h1>
      <p className="guardian__body">
        {organizationName} needs your current contact details. This takes about a minute,
        and this link can only be used once.
      </p>

      {submit.isError ? (
        <p className="guardian__error" role="alert">
          We couldn’t send your details just now. Please check the form and try again.
        </p>
      ) : null}

      <form
        className="guardian__form"
        onSubmit={(e) => { e.preventDefault(); submit.mutate(); }}
      >
        <Field label="Phone number" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} type="tel" autoComplete="tel" />
        <Field label="Email address" value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" autoComplete="email" />
        <Field label="Address" value={form.addressLine1} onChange={(v) => setForm({ ...form, addressLine1: v })} autoComplete="address-line1" wide />
        <Field label="Apartment, suite (optional)" value={form.addressLine2} onChange={(v) => setForm({ ...form, addressLine2: v })} autoComplete="address-line2" wide />
        <Field label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} autoComplete="address-level2" />
        <Field label="State" value={form.state} onChange={(v) => setForm({ ...form, state: v })} autoComplete="address-level1" />
        <Field label="ZIP code" value={form.postalCode} onChange={(v) => setForm({ ...form, postalCode: v })} autoComplete="postal-code" />

        <div className="guardian__actions">
          <button
            type="submit"
            className="guardian__submit"
            disabled={submit.isPending || nothingFilled}
          >
            {submit.isPending ? 'Sending…' : 'Send my details'}
          </button>
          {nothingFilled ? (
            <p className="guardian__hint">Fill in at least one detail to continue.</p>
          ) : null}
        </div>
      </form>
    </Shell>
  );
}

/** Only send fields the family actually filled in. */
function filled(form) {
  return Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ''));
}

function Shell({ organizationName, children }) {
  return (
    <div className="guardian">
      <div className="guardian__card">
        {organizationName ? <p className="guardian__org">{organizationName}</p> : null}
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', autoComplete, wide = false }) {
  return (
    <label className={`guardian__field${wide ? ' guardian__field--wide' : ''}`}>
      <span>{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
