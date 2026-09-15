import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { submitInquiry } from '@/api/inquiries';
import { Icon } from '@/components/Icon.jsx';
import { SiteLayout } from '@/components/SiteLayout.jsx';
import { EASE } from '@/components/motion.jsx';

/**
 * Contact page. Submits to the real inquiry endpoint, which stores the inquiry,
 * notifies the Abstract ABA team and emails the visitor a confirmation. Field
 * rules mirror the server's; the server remains the authority. Technical error
 * details are never shown.
 */
export const SUCCESS_MESSAGE = `Thank you for contacting ${PLATFORM_BRAND.productName}. We’ve received your inquiry and our team will connect with you soon.`;

const FIELDS = ['name', 'organization', 'email', 'phone', 'subject', 'message'];
const EMPTY = { name: '', organization: '', email: '', phone: '', subject: '', message: '', website: '' };
const LIMITS = { name: 120, organization: 200, email: 254, phone: 40, subject: 150, message: 5000 };

export function validateInquiry(values) {
  const errors = {};
  const v = (k) => String(values[k] ?? '').trim();
  if (v('name').length < 2) errors.name = 'Enter your full name.';
  else if (v('name').length > LIMITS.name) errors.name = `Full name must be ${LIMITS.name} characters or fewer.`;
  if (v('organization').length < 2) errors.organization = 'Enter your company or organization.';
  else if (v('organization').length > LIMITS.organization) errors.organization = `Organization must be ${LIMITS.organization} characters or fewer.`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('email')) || v('email').length > LIMITS.email) errors.email = 'Enter a valid work email.';
  if (v('phone') && !/^[+()\-.\s0-9]{7,40}$/.test(v('phone'))) errors.phone = 'Enter a valid phone number, or leave it blank.';
  if (v('subject').length < 3) errors.subject = 'Enter a subject.';
  else if (v('subject').length > LIMITS.subject) errors.subject = `Subject must be ${LIMITS.subject} characters or fewer.`;
  if (v('message').length < 10) errors.message = 'Please tell us a little more (at least 10 characters).';
  else if (v('message').length > LIMITS.message) errors.message = 'Message must be 5,000 characters or fewer.';
  return errors;
}

function serverFieldErrors(error) {
  const fieldErrors = error?.fieldErrors;
  if (!fieldErrors) return {};
  const out = {};
  for (const key of FIELDS) {
    if (Array.isArray(fieldErrors[key]) && fieldErrors[key][0]) out[key] = fieldErrors[key][0];
  }
  return out;
}

function TextField({ id, label, optional, full, error, children }) {
  return (
    <div className={`ps-field${full ? ' ps-field--full' : ''}${error ? ' has-error' : ''}`}>
      <label htmlFor={id} className="ps-field__label">
        {label}
        {optional ? <span className="ps-field__optional"> (optional)</span> : <span className="ps-field__req" aria-hidden="true"> *</span>}
      </label>
      {children}
      {error ? <p id={`${id}-error`} className="ps-field__error">{error}</p> : null}
    </div>
  );
}

export function ContactPage() {
  const reduce = useReducedMotion();
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState('');
  const formRef = useRef(null);
  // Move focus to the confirmation once it mounts (after the exit animation).
  const focusOnMount = useCallback((el) => { el?.focus(); }, []);

  const set = (key) => (e) => {
    const next = { ...values, [key]: e.target.value };
    setValues(next);
    if (submitted) setErrors(validateInquiry(next));
  };

  const inputProps = (key) => ({
    id: `contact-${key}`,
    name: key,
    value: values[key],
    onChange: set(key),
    maxLength: LIMITS[key],
    'aria-required': key === 'phone' ? undefined : true,
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `contact-${key}-error` : undefined,
  });

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setFormError('');
    const found = validateInquiry(values);
    setErrors(found);
    const firstInvalid = FIELDS.find((k) => found[k]);
    if (firstInvalid) {
      formRef.current?.querySelector(`#contact-${firstInvalid}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const body = {
        name: values.name.trim(),
        organization: values.organization.trim(),
        email: values.email.trim(),
        subject: values.subject.trim(),
        message: values.message.trim(),
        website: values.website,
      };
      if (values.phone.trim()) body.phone = values.phone.trim();
      await submitInquiry(body);
      setSent(true);
      setValues(EMPTY);
      setSubmitted(false);
      setErrors({});
    } catch (error) {
      const status = error?.status;
      const fromServer = status === 422 ? serverFieldErrors(error) : {};
      if (Object.keys(fromServer).length) {
        setErrors(fromServer);
        setFormError('Please review the highlighted fields and try again.');
      } else if (status === 429) {
        setFormError(`You’ve sent several messages in a short time. Please try again later, or email us at ${PLATFORM_BRAND.supportEmail}.`);
      } else {
        setFormError(`We couldn’t send your message right now. Please try again in a moment, or email us at ${PLATFORM_BRAND.supportEmail}.`);
      }
    } finally {
      setBusy(false);
    }
  }

  const fade = reduce
    ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } }
    : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: { duration: 0.35, ease: EASE } };

  return (
    <SiteLayout title="Contact Us" description={`Contact ${PLATFORM_BRAND.productName} to learn how our ABA practice management software can fit your organization.`}>
      <section className="ps-page-hero" aria-labelledby="contact-title">
        <div className="ps-hero__bg" aria-hidden="true" />
        <div className="ps-container ps-contact">
          <div className="ps-contact__intro">
            <p className="ps-eyebrow">Contact us</p>
            <h1 id="contact-title" className="ps-h1 ps-h1--page">Let&apos;s Talk</h1>
            <p className="ps-lead">Tell us a little about your organization and how we can help.</p>
            <ul className="ps-contact__points">
              <li><span className="ps-icon-tile"><Icon.Calendar size={18} /></span><span>Learn how {PLATFORM_BRAND.productName} supports scheduling, sessions, billing and payroll.</span></li>
              <li><span className="ps-icon-tile"><Icon.Users size={18} /></span><span>Discuss your organization’s roles, team and workflow.</span></li>
              <li><span className="ps-icon-tile"><Icon.Inbox size={18} /></span><span>Prefer email? Write to <a href={`mailto:${PLATFORM_BRAND.supportEmail}`}>{PLATFORM_BRAND.supportEmail}</a>.</span></li>
            </ul>
            <p className="ps-contact__note">
              Please don’t include client health information in this form. See our <Link to="/privacy-policy">Privacy Policy</Link> for how we handle inquiries.
            </p>
          </div>

          <div className="ps-contact__card">
            <AnimatePresence mode="wait" initial={false}>
              {sent ? (
                <motion.div key="sent" className="ps-contact__success" {...fade}>
                  <span className="ps-contact__success-icon" aria-hidden="true"><Icon.CheckCircle size={30} /></span>
                  <h2 className="ps-h3" tabIndex={-1} ref={focusOnMount}>Message sent</h2>
                  <p role="status">{SUCCESS_MESSAGE}</p>
                  <div className="ps-contact__success-actions">
                    <Link to="/" className="ps-btn ps-btn--outline">Back to Home</Link>
                    <button type="button" className="ps-btn ps-btn--ghost" onClick={() => setSent(false)}>Send another message</button>
                  </div>
                </motion.div>
              ) : (
                <motion.form key="form" ref={formRef} className="ps-form" onSubmit={onSubmit} noValidate aria-labelledby="contact-form-title" {...fade}>
                  <h2 id="contact-form-title" className="ps-h3">Send us a message</h2>
                  <p className="ps-form__hint">Fields marked with * are required.</p>

                  {formError ? (
                    <div className="ps-alert" role="alert">
                      <Icon.Alert size={18} aria-hidden="true" /><span>{formError}</span>
                    </div>
                  ) : null}

                  <div className="ps-form__grid">
                    <TextField id="contact-name" label="Full Name" error={errors.name}>
                      <input type="text" autoComplete="name" {...inputProps('name')} />
                    </TextField>
                    <TextField id="contact-organization" label="Company / Organization" error={errors.organization}>
                      <input type="text" autoComplete="organization" {...inputProps('organization')} />
                    </TextField>
                    <TextField id="contact-email" label="Work Email" error={errors.email}>
                      <input type="email" autoComplete="email" inputMode="email" {...inputProps('email')} />
                    </TextField>
                    <TextField id="contact-phone" label="Phone" optional error={errors.phone}>
                      <input type="tel" autoComplete="tel" inputMode="tel" {...inputProps('phone')} />
                    </TextField>
                    <TextField id="contact-subject" label="Subject" full error={errors.subject}>
                      <input type="text" {...inputProps('subject')} />
                    </TextField>
                  </div>
                  <TextField id="contact-message" label="Message" error={errors.message}>
                    <textarea rows={6} {...inputProps('message')} />
                  </TextField>

                  {/* Honeypot: hidden from people and assistive technology; bots fill it. */}
                  <div className="ps-hp" aria-hidden="true">
                    <label htmlFor="contact-website">Website</label>
                    <input id="contact-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={values.website} onChange={set('website')} />
                  </div>

                  <button type="submit" className="ps-btn ps-btn--primary ps-btn--lg ps-btn--block" disabled={busy} aria-busy={busy || undefined}>
                    {busy ? <span className="ps-spinner" aria-hidden="true" /> : null}
                    <span>{busy ? 'Sending…' : 'Send Inquiry'}</span>
                    {busy ? null : <Icon.Arrow size={18} aria-hidden="true" />}
                  </button>
                </motion.form>
              )}
            </AnimatePresence>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}

export default ContactPage;
