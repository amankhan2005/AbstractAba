import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { selfServeSignup } from '@/api/client';
import { Button, Card } from '@/components';

const EMPTY = {
  slug: '', legalName: '', tradingName: '', countryCode: '', stateCode: '', timezone: '',
  ownerFullName: '', ownerEmail: '',
  agreementVersion: 'v1', acceptedByName: '', acceptedByTitle: '', accepted: false,
};

/**
 * Public self-serve clinic signup (BR-3). A clinic that does not yet exist
 * registers here without authentication. Submission calls the public signup
 * endpoint, which creates the organization behind the existing agreement gate,
 * records the accepted business-associate agreement, and invites the first
 * owner. The clinic reaches PENDING_AGREEMENT — an operator countersigns and
 * activates. On success we show that pending state; no browser dialogs.
 */
export function SelfServeSignupPage() {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);
  const inFlight = useRef(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e) {
    e.preventDefault();
    if (inFlight.current) return; // exactly one POST per submission, even on rapid double-submit
    setError(null);
    if (!form.accepted) { setError('You must accept the business associate agreement to continue.'); return; }
    inFlight.current = true;
    setSubmitting(true);
    try {
      const result = await selfServeSignup({
        slug: form.slug.trim().toLowerCase(),
        legalName: form.legalName.trim(),
        tradingName: form.tradingName.trim(),
        countryCode: form.countryCode.trim().toUpperCase(),
        ...(form.stateCode.trim() ? { stateCode: form.stateCode.trim() } : {}),
        timezone: form.timezone.trim(),
        ownerFullName: form.ownerFullName.trim(),
        ownerEmail: form.ownerEmail.trim(),
        agreement: {
          version: form.agreementVersion,
          acceptedByName: form.acceptedByName.trim(),
          acceptedByTitle: form.acceptedByTitle.trim(),
          accepted: true,
        },
      });
      setDone(result);
    } catch (err) {
      setError(err?.response?.data?.error?.message ?? 'Could not complete signup. Please check your details and try again.');
    } finally {
      setSubmitting(false);
      inFlight.current = false;
    }
  }

  if (done) {
    return (
      <div className="auth-shell">
        <Card>
          <h1>You're almost there</h1>
          <p>Your clinic <strong>{done.slug}</strong> has been created and is pending agreement review.</p>
          <p>{done.nextStep}</p>
          <p className="muted">We've sent an owner invitation to <strong>{done.ownerEmail}</strong>. Accept it to set your password.</p>
          <p style={{ marginTop: '1rem' }}><Link to="/login">Return to sign in</Link></p>
        </Card>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <Card>
        <h1 className="page-title">Create your clinic</h1>
        <p className="muted">Set up your organization. Your clinic is activated once your agreement is countersigned.</p>
        <form onSubmit={onSubmit}>
          <fieldset>
            <legend>Clinic information</legend>
            <div className="ui-fields">
              <label>Clinic URL name (slug)
                <input value={form.slug} onChange={set('slug')} placeholder="bright-aba" required minLength={3} maxLength={63} />
              </label>
              <label>Legal name
                <input value={form.legalName} onChange={set('legalName')} required minLength={2} maxLength={200} />
              </label>
              <label>Trading name
                <input value={form.tradingName} onChange={set('tradingName')} required minLength={2} maxLength={200} />
              </label>
              <label>Country code
                <input value={form.countryCode} onChange={set('countryCode')} placeholder="US" required minLength={2} maxLength={2} />
              </label>
              <label>State/region (optional)
                <input value={form.stateCode} onChange={set('stateCode')} maxLength={10} />
              </label>
              <label>Timezone
                <input value={form.timezone} onChange={set('timezone')} placeholder="America/New_York" required />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Your information</legend>
            <div className="ui-fields">
              <label>Your full name
                <input value={form.ownerFullName} onChange={set('ownerFullName')} required minLength={2} maxLength={200} />
              </label>
              <label>Your work email
                <input type="email" value={form.ownerEmail} onChange={set('ownerEmail')} required maxLength={320} />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Business associate agreement</legend>
            <div className="ui-fields">
              <label>Signer name
                <input value={form.acceptedByName} onChange={set('acceptedByName')} required minLength={2} maxLength={200} />
              </label>
              <label>Signer title
                <input value={form.acceptedByTitle} onChange={set('acceptedByTitle')} required minLength={2} maxLength={200} />
              </label>
            </div>
            <label className="ui-row" style={{ gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
              <input type="checkbox" checked={form.accepted} onChange={(e) => setForm((f) => ({ ...f, accepted: e.target.checked }))} />
              I have read and accept the business associate agreement on behalf of this clinic.
            </label>
          </fieldset>

          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="ui-row" style={{ marginTop: '1rem' }}>
            <Button type="submit" disabled={submitting}>{submitting ? 'Creating…' : 'Create clinic'}</Button>
          </div>
        </form>
        <p className="muted" style={{ marginTop: '1rem' }}>Already have an account? <Link to="/login">Sign in</Link></p>
      </Card>
    </div>
  );
}
