import { useState, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import { previewCompanyInvitation, submitCompanyOnboarding } from '@/api/client';
import { useAuthStore } from '@/auth/store';
import { Button, Spinner, Icon } from '@/ui';
import { Field, TextInput, Select, Modal, WizardPanel } from '@/ui/components/index.js';
import { ORGANIZATION_TIME_ZONES, timeZoneName } from '@/lib/timezones.js';
import { PLATFORM_BRAND } from '@aba1on1/schemas';
import { BrandLogo } from '@/ui/BrandLogo.jsx';

/**
 * COMPANY ONBOARDING — a guided setup flow for an invited company.
 *
 * The backend contract is unchanged: a single POST /:token/accept (via
 * submitCompanyOnboarding) records the agreement behind the agreement gate,
 * activates the organization and establishes a session. This component collects
 * ONLY what that request requires — company name, legal name, country, timezone,
 * the owner's name, title and password, and the agreement acceptance. Optional
 * details (operating states, locale, registered state, logo) are not asked for
 * here; they can be added later in Company Profile. The login email comes from
 * the invitation and the workspace address is derived from the company name.
 * No tenant/organization/agreement IDs or lifecycle values are ever shown.
 */

const EMPTY = {
  tradingName: '', legalName: '', countryCode: 'US', timezone: 'America/New_York',
  primaryContactName: '', agreeTitle: '', password: '', confirmPassword: '',
};

function deriveSlug(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

const STEPS = [
  { id: 'company', label: 'Company information', description: 'Your company name, country and timezone.' },
  { id: 'account', label: 'Account setup', description: 'Your name, title and password.' },
  { id: 'review', label: 'Review', description: 'Check your details.' },
  { id: 'agreement', label: 'Agreement', description: 'Accept the terms and complete setup.' },
];

function AuthStage({ children, rail }) {
  return (
    <div className="rx-gate rx-onb">
      <div className="rx-gate__backdrop" aria-hidden="true" />
      <header className="rx-gate__top">
        <span className="rx-gate__brand"><BrandLogo size="md" tone="onDark" /></span>
      </header>
      <main className={`rx-onb__stage${rail ? '' : ' rx-onb__stage--single'}`}>
        {rail}
        {children}
      </main>
      <footer className="rx-gate__foot">© {new Date().getFullYear()} {PLATFORM_BRAND.productName} · Product of {PLATFORM_BRAND.providerName}</footer>
    </div>
  );
}

export function CompanyOnboardingPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const adoptSession = useAuthStore((s) => s.adoptSession);

  const [step, setStep] = useState(0);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [agreeChecked, setAgreeChecked] = useState(false);
  const [agreeAccepted, setAgreeAccepted] = useState(false); // confirmed via modal "I Agree"
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const inFlightRef = useRef(false);

  const preview = useQuery({
    queryKey: ['company-invitation-preview', token],
    queryFn: () => previewCompanyInvitation(token),
    retry: false,
  });

  const set = (key) => (e) => {
    const value = e?.target ? e.target.value : e;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const slug = useMemo(() => deriveSlug(form.tradingName), [form.tradingName]);

  function validateStep(index) {
    const e = {};
    if (index === 0) {
      if (form.tradingName.trim().length < 2) e.tradingName = 'Please enter your company name.';
      else if (deriveSlug(form.tradingName).length < 3) e.tradingName = 'Company name must include at least 3 letters or numbers.';
      if (form.legalName.trim().length < 2) e.legalName = 'Please enter your legal company name.';
      if (form.countryCode.trim().length !== 2) e.countryCode = 'Enter a 2-letter country code, for example US.';
      if (!form.timezone.trim()) e.timezone = 'Please choose a timezone.';
    }
    if (index === 1) {
      if (form.primaryContactName.trim().length < 2) e.primaryContactName = 'Please enter your name.';
      if (form.agreeTitle.trim().length < 2) e.agreeTitle = 'Please enter your title, for example Owner.';
      if (form.password.length < 10) e.password = 'Password must be at least 10 characters.';
      if (form.password !== form.confirmPassword) e.confirmPassword = 'Passwords do not match.';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function next() { if (validateStep(step)) setStep((s) => Math.min(s + 1, STEPS.length - 1)); }
  function back() { setErrors({}); setStep((s) => Math.max(s - 1, 0)); }

  function acceptAgreement() {
    if (!agreeChecked) return;
    setAgreeAccepted(true);
    setAgreementOpen(false);
  }

  async function submit() {
    if (inFlightRef.current) return;
    if (!agreeAccepted) { setSubmitError('Please review and accept the agreement to complete setup.'); return; }
    setSubmitError(null);
    const details = {
      slug,
      legalName: form.legalName.trim(),
      tradingName: form.tradingName.trim(),
      countryCode: form.countryCode.trim().toUpperCase(),
      timezone: form.timezone.trim(),
      primaryContactName: form.primaryContactName.trim(),
      password: form.password,
      agreement: {
        accepted: true,
        acceptedByTitle: form.agreeTitle.trim(),
        ...(preview.data?.agreement?.version ? { version: preview.data.agreement.version } : {}),
      },
    };
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const result = await submitCompanyOnboarding(token, details);
      const session = result?.session;
      if (session?.status === 'ESTABLISHED' && session.accessToken) {
        const ok = await adoptSession(session.accessToken);
        if (ok) { navigate('/', { replace: true }); return; }
      }
      setNeedsSignIn(true);
    } catch (err) {
      const data = err?.response?.data?.error;
      const fieldErrors = data?.details?.fieldErrors ?? data?.details;
      if (fieldErrors && typeof fieldErrors === 'object' && !Array.isArray(fieldErrors)) {
        const msgs = Object.entries(fieldErrors).flatMap(([k, v]) => (Array.isArray(v) ? v.map((m) => `${k}: ${m}`) : []));
        setSubmitError(msgs.length ? msgs.join('  •  ') : (data?.message ?? 'Something went wrong. Please try again.'));
      } else {
        setSubmitError(data?.message ?? 'Something went wrong. Please check your details and try again.');
      }
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  if (preview.isLoading) {
    return (
      <AuthStage>
        <section className="rx-onb__card rx-onb__card--state" aria-busy="true"><Spinner /><p>Loading your invitation…</p></section>
      </AuthStage>
    );
  }
  if (preview.isError) {
    return (
      <AuthStage>
        <section className="rx-onb__card rx-onb__card--state" role="alert">
          <span className="rx-onb__state-icon rx-onb__state-icon--error" aria-hidden="true"><Icon.Bell size={22} /></span>
          <h1>Invitation unavailable</h1>
          <p>This invitation is invalid or has expired. Please ask your administrator to send a new one.</p>
        </section>
      </AuthStage>
    );
  }

  if (needsSignIn) {
    return (
      <AuthStage>
        <section className="rx-onb__card rx-onb__card--state">
          <span className="rx-onb__state-icon" aria-hidden="true"><Icon.CheckCircle size={24} /></span>
          <h1>Your account is ready</h1>
          <p>Your company is set up and active. Please sign in with the email and password you just chose.</p>
          <Button onClick={() => navigate('/login', { replace: true })}>Sign in</Button>
        </section>
      </AuthStage>
    );
  }

  const invited = preview.data;
  const agreement = invited.agreement ?? {};
  const agreementLabel = agreement.title
    ? `${agreement.title}${agreement.version ? ` (v${agreement.version})` : ''}`
    : 'the required agreement';
  const current = STEPS[step];

  const rail = (
    <aside className="rx-onb__rail" aria-label="Setup progress">
      <p className="rx-gate__eyebrow">Company setup</p>
      <h2 className="rx-onb__rail-title">Welcome to {PLATFORM_BRAND.productName}</h2>
      <p className="rx-onb__rail-lead">Set up {invited.companyName || 'your company'} in a few short steps.</p>
      <ol className="rx-onb__steps">
        {STEPS.map((s, i) => {
          const state = i < step ? 'done' : i === step ? 'current' : 'todo';
          return (
            <li key={s.id} className={`rx-onb__step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="rx-onb__step-dot" aria-hidden="true">{state === 'done' ? <Icon.Check size={14} /> : i + 1}</span>
              <span className="rx-onb__step-text"><strong>{s.label}</strong><span>{s.description}</span></span>
            </li>
          );
        })}
      </ol>
      <p className="rx-onb__rail-foot"><Icon.User size={15} aria-hidden="true" /> Invitation for {invited.email}</p>
    </aside>
  );

  return (
    <AuthStage rail={rail}>
      <section className="rx-onb__card" aria-labelledby="onb-step-title">
        <div className="rx-onb__progress" aria-hidden="true"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
        <header className="rx-onb__card-head">
          <span className="rx-onb__count">Step {step + 1} of {STEPS.length}</span>
          <h1 id="onb-step-title">{current.label}</h1>
          <p>{current.description}</p>
        </header>

        <AnimatePresence initial={false}>
          <WizardPanel key={current.id}>
            {step === 0 && (
              <div className="rx-onb__fields">
                <Field label="Company name" htmlFor="ob-trading" required error={errors.tradingName} hint="The name your staff and families will see.">
                  <TextInput id="ob-trading" value={form.tradingName} onChange={set('tradingName')} error={!!errors.tradingName} placeholder="Sunrise ABA" autoComplete="organization" />
                </Field>
                <Field label="Legal company name" htmlFor="ob-legal" required error={errors.legalName}>
                  <TextInput id="ob-legal" value={form.legalName} onChange={set('legalName')} error={!!errors.legalName} placeholder="Sunrise ABA Therapy, LLC" />
                </Field>
                <div className="rx-onb__row">
                  <Field label="Country" htmlFor="ob-country" required error={errors.countryCode} hint="2-letter country code.">
                    <TextInput id="ob-country" value={form.countryCode} onChange={set('countryCode')} error={!!errors.countryCode} maxLength={2} placeholder="US" />
                  </Field>
                  <Field label="Timezone" htmlFor="ob-tz" required error={errors.timezone}>
                    <Select id="ob-tz" portal value={form.timezone} onChange={set('timezone')} options={ORGANIZATION_TIME_ZONES.map((z) => ({ value: z.value, label: z.name }))} searchable={false} />
                  </Field>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="rx-onb__fields">
                <div className="rx-onb__info"><Icon.User size={16} aria-hidden="true" /> You will sign in with <strong>{invited.email}</strong></div>
                <div className="rx-onb__row">
                  <Field label="Your name" htmlFor="ob-name" required error={errors.primaryContactName}>
                    <TextInput id="ob-name" value={form.primaryContactName} onChange={set('primaryContactName')} error={!!errors.primaryContactName} placeholder="Jordan Lee" autoComplete="name" />
                  </Field>
                  <Field label="Your title" htmlFor="ob-title" required error={errors.agreeTitle} hint="Used when you accept the agreement.">
                    <TextInput id="ob-title" value={form.agreeTitle} onChange={set('agreeTitle')} error={!!errors.agreeTitle} placeholder="Owner" autoComplete="organization-title" />
                  </Field>
                </div>
                <div className="rx-onb__row">
                  <Field label="Password" htmlFor="ob-pw" required error={errors.password} hint="At least 10 characters.">
                    <TextInput id="ob-pw" type="password" value={form.password} onChange={set('password')} error={!!errors.password} autoComplete="new-password" />
                  </Field>
                  <Field label="Confirm password" htmlFor="ob-pw2" required error={errors.confirmPassword}>
                    <TextInput id="ob-pw2" type="password" value={form.confirmPassword} onChange={set('confirmPassword')} error={!!errors.confirmPassword} autoComplete="new-password" />
                  </Field>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="rx-onb__review">
                <ReviewGroup title="Company information" onEdit={() => setStep(0)}>
                  <ReviewRow label="Company name" value={form.tradingName} />
                  <ReviewRow label="Legal name" value={form.legalName} />
                  <ReviewRow label="Country" value={form.countryCode.toUpperCase()} />
                  <ReviewRow label="Timezone" value={timeZoneName(form.timezone)} />
                </ReviewGroup>
                <ReviewGroup title="Account setup" onEdit={() => setStep(1)}>
                  <ReviewRow label="Your name" value={form.primaryContactName} />
                  <ReviewRow label="Your title" value={form.agreeTitle} />
                  <ReviewRow label="Login email" value={invited.email} />
                </ReviewGroup>
                <p className="rx-onb__note">You can add more company details later in Company Profile.</p>
              </div>
            )}

            {step === 3 && (
              <div className="rx-onb__fields">
                <div className="rx-onb__agreement">
                  <span className="rx-onb__agreement-icon" aria-hidden="true"><Icon.Doc size={20} /></span>
                  <div>
                    <strong>{AGREEMENT_TITLE}</strong>
                    <p>Review and accept the agreement on behalf of {form.tradingName || 'your company'} to complete setup. It covers the platform provider, your organization’s responsibilities, privacy, security and healthcare information{agreement.title ? `, and records your acceptance of the ${agreementLabel}` : ''}.</p>
                    <Button variant="ghost" icon={Icon.Doc} onClick={() => setAgreementOpen(true)}>Review terms</Button>
                  </div>
                </div>
                {agreeAccepted ? (
                  <p className="rx-onb__accepted"><Icon.CheckCircle size={16} aria-hidden="true" /> Accepted by {form.primaryContactName} ({form.agreeTitle}).</p>
                ) : (
                  <p className="rx-onb__note">You need to accept the agreement before you can complete setup.</p>
                )}
                {submitError ? <p className="rx-formfield__err">{submitError}</p> : null}
              </div>
            )}
          </WizardPanel>
        </AnimatePresence>

        <footer className="rx-onb__actions">
          <Button variant="ghost" onClick={back} disabled={step === 0 || submitting}>Back</Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={next} icon={Icon.Arrow}>Continue</Button>
          ) : (
            <Button onClick={submit} loading={submitting} disabled={!agreeAccepted || submitting}>
              {submitting ? 'Completing setup…' : 'Complete setup'}
            </Button>
          )}
        </footer>
      </section>

      <Modal
        open={agreementOpen}
        onClose={() => setAgreementOpen(false)}
        title={AGREEMENT_TITLE}
        description={`Welcome to ${PLATFORM_BRAND.productName}. Please read the agreement before completing setup.`}
        size="lg"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setAgreementOpen(false)}>Cancel</Button>
            <Button onClick={acceptAgreement} disabled={!agreeChecked}>I Agree</Button>
          </>
        )}
      >
        <AgreementDocument
          companyName={form.tradingName.trim() || 'your organization'}
          signer={form.primaryContactName.trim()}
          signerTitle={form.agreeTitle.trim()}
          agreementLabel={agreement.title ? agreementLabel : null}
        />
        <label className="rx-onb__agree">
          <input type="checkbox" checked={agreeChecked} onChange={(e) => setAgreeChecked(e.target.checked)} />
          <span>I have read and agree to the {AGREEMENT_TITLE} on behalf of {form.tradingName.trim() || 'my organization'}, and I am authorized to accept it.</span>
        </label>
      </Modal>
    </AuthStage>
  );
}

const AGREEMENT_TITLE = 'Company Onboarding Agreement';

/**
 * The onboarding agreement text shown before acceptance. Presentation only: the
 * agreement that is RECORDED (type, version, document reference) stays pinned
 * server-side (ONBOARDING_AGREEMENT) and is named here via `agreementLabel`.
 * Wording is deliberately conservative — it describes how the platform works
 * and makes no certification, compliance or encryption claims.
 */
function AgreementDocument({ companyName, signer, signerTitle, agreementLabel }) {
  const { productName, providerName, supportEmail } = PLATFORM_BRAND;
  const sections = [
    {
      title: 'Platform provider',
      body: [
        `${providerName} provides and operates the ${productName} software platform.`,
        `${companyName} is an independent organization using the platform. ${providerName} is not your healthcare organization and does not provide clinical services to your clients.`,
      ],
    },
    {
      title: 'Organization responsibilities',
      body: [
        `${companyName} remains responsible for the information and records it enters into the platform, including their accuracy and completeness.`,
        'You decide who is invited, which role each person has, and when access should be removed, and you are responsible for your organization’s use of the platform under the laws and payer requirements that apply to your practice.',
        'Keep sign-in credentials confidential, and contact support promptly if you believe an account has been misused.',
      ],
    },
    {
      title: 'Data privacy',
      body: [
        `${productName} is designed as a privacy-focused healthcare software platform. Your organization’s data stays associated with your organization’s workspace.`,
        `${providerName} processes the information necessary to provide, maintain, secure and operate the service. This includes authentication, security and audit information, access records, and usage information needed to run the service.`,
        `${providerName} does not use the platform to independently monitor your employees or your business activities, and the platform does not intentionally track users’ activity outside the software.`,
      ],
    },
    {
      title: 'Security',
      body: [
        'Access is controlled by role, each organization’s workspace is kept separate from other organizations, and key actions are recorded in an audit trail.',
        `${providerName} is committed to providing a secure, privacy-focused platform designed to support healthcare organizations and the protection of sensitive information.`,
      ],
    },
    {
      title: 'Healthcare information',
      body: [
        'The platform may hold protected health information about the people your organization serves. It is available only to authorized users of your organization, according to their role.',
        'Enter only the information your organization needs for care, scheduling, billing and payroll, and handle exported or printed records confidentially.',
        ...(agreementLabel ? [`As part of this setup, your acceptance is recorded as the ${agreementLabel} for ${companyName}.`] : []),
      ],
    },
    {
      title: 'Platform usage',
      body: [
        'Use the platform only for your organization’s lawful practice management. Do not attempt to access another organization’s information or to bypass security controls.',
        `For help with ${productName}, contact ${supportEmail}.`,
      ],
    },
    {
      title: 'Acceptance',
      body: [
        `By selecting “I Agree”, you confirm that you have read this agreement and are authorized to accept it on behalf of ${companyName}.${signer ? ` Your acceptance is recorded under your name (${signer}${signerTitle ? `, ${signerTitle}` : ''}).` : ''}`,
      ],
    },
  ];
  return (
    <div className="rx-onb__terms" tabIndex={0} aria-label={`${AGREEMENT_TITLE} text`}>
      <p className="rx-onb__terms-lead">
        This agreement is between <strong>{companyName}</strong> and <strong>{providerName}</strong>, the provider of {productName}.
      </p>
      <dl className="rx-onb__terms-provider">
        <div><dt>Platform provider</dt><dd>{providerName}</dd></div>
        <div><dt>Support</dt><dd><a className="rx-link" href={`mailto:${supportEmail}`}>{supportEmail}</a></dd></div>
      </dl>
      <ol className="rx-onb__terms-sections">
        {sections.map((section) => (
          <li key={section.title}>
            <h3>{section.title}</h3>
            {section.body.map((text) => <p key={text}>{text}</p>)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReviewGroup({ title, onEdit, children }) {
  return (
    <div className="rx-onb__review-group">
      <div className="rx-onb__review-head"><strong>{title}</strong><button type="button" className="rx-link" onClick={onEdit}>Edit</button></div>
      <dl>{children}</dl>
    </div>
  );
}

function ReviewRow({ label, value }) {
  return (
    <div className="rx-onb__review-row">
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );
}

export default CompanyOnboardingPage;
