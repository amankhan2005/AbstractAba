import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { resolveGuardianInvitation, submitGuardianInvitation } from '@/api/client';
import { Icon } from '@/ui/icons.jsx';
import { Button } from '@/ui/primitives.jsx';
import { Field, TextInput } from '@/ui/components/Field.jsx';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * Public guardian page — the one unauthenticated, one-time-token surface the
 * blueprint allows (NOT a family portal). Redesigned to feel premium, calm and
 * secure, with plain language and mobile-first layout. Same API contract:
 * resolve the token, submit only the details the family filled in.
 */
const filled = (form) => Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ''));

function Shell({ org, children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20, background: 'var(--rx-canvas)' }}>
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        style={{ width: '100%', maxWidth: 440, background: 'var(--rx-surface)', border: '1px solid var(--rx-line)', borderRadius: 20, boxShadow: 'var(--rx-shadow-lg)', overflow: 'hidden' }}>
        <div style={{ background: 'var(--brand-gradient)', color: '#fff', padding: '22px 24px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,.18)', display: 'grid', placeItems: 'center' }}><Icon.Shield size={18} /></span>
          <div><div style={{ fontWeight: 700 }}>{org || PLATFORM_BRAND.productName}</div><div style={{ fontSize: '0.75rem', opacity: 0.85 }}>Secure guardian request</div></div>
        </div>
        <div style={{ padding: 24 }}>{children}</div>
      </motion.div>
    </div>
  );
}

export function GuardianPublicRedesign() {
  const { token } = useParams();
  const [form, setForm] = useState({ phone: '', email: '', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const invitation = useQuery({ queryKey: ['guardian-invitation', token], queryFn: () => resolveGuardianInvitation(token), enabled: Boolean(token), retry: false, refetchOnWindowFocus: false });
  const submit = useMutation({ mutationFn: () => submitGuardianInvitation(token, filled(form)) });

  if (invitation.isPending) return <Shell><div className="rx-state"><div className="rx-spinner" /></div></Shell>;
  if (invitation.isError) return (
    <Shell>
      <h1 style={{ fontSize: '1.3rem', fontWeight: 720, margin: '0 0 8px' }}>This link is no longer valid</h1>
      <p style={{ color: 'var(--rx-ink-soft)', lineHeight: 1.55 }}>It may have already been used, or it may have expired. Please contact your clinic and ask them to send you a new one.</p>
    </Shell>
  );
  if (submit.isSuccess) return (
    <Shell org={invitation.data.organizationName}>
      <div className="rx-state">
        <div className="rx-state__icon" style={{ color: 'var(--color-state-approved)', background: 'var(--color-state-approved-surface)' }}><Icon.CheckCircle size={26} /></div>
        <div className="rx-state__title">Thank you</div>
        <div className="rx-state__body">Your details have been sent to {invitation.data.organizationName}. There's nothing else you need to do — you can close this page.</div>
      </div>
    </Shell>
  );

  const { organizationName, childFirstName } = invitation.data;
  const nothingFilled = Object.keys(filled(form)).length === 0;

  return (
    <Shell org={organizationName}>
      <h1 style={{ fontSize: '1.3rem', fontWeight: 720, margin: '0 0 6px' }}>A few details for {childFirstName}</h1>
      <p style={{ color: 'var(--rx-ink-soft)', lineHeight: 1.55, marginTop: 0 }}>{organizationName} needs your current contact details. This takes about a minute, and this link can only be used once.</p>

      {submit.isError && <div className="rx-alert" role="alert"><Icon.Bell size={18} /><span>We couldn’t send your details just now. Please check the form and try again.</span></div>}

      <form onSubmit={(e) => { e.preventDefault(); submit.mutate(); }}>
        <Field label="Phone number"><TextInput type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} icon={Icon.User} /></Field>
        <Field label="Email address"><TextInput type="email" autoComplete="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Address"><TextInput autoComplete="address-line1" value={form.addressLine1} onChange={set('addressLine1')} /></Field>
        <Field label="Apartment, suite (optional)"><TextInput autoComplete="address-line2" value={form.addressLine2} onChange={set('addressLine2')} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="City"><TextInput autoComplete="address-level2" value={form.city} onChange={set('city')} /></Field>
          <Field label="State"><TextInput autoComplete="address-level1" value={form.state} onChange={set('state')} /></Field>
        </div>
        <Field label="ZIP code"><TextInput autoComplete="postal-code" value={form.postalCode} onChange={set('postalCode')} /></Field>

        <Button type="submit" size="lg" block loading={submit.isPending} disabled={nothingFilled}>
          {submit.isPending ? 'Sending…' : 'Send my details'}
        </Button>
        {nothingFilled && <p className="rx-formfield__hint" style={{ textAlign: 'center', marginTop: 8 }}>Fill in at least one detail to continue.</p>}
      </form>
    </Shell>
  );
}

export default GuardianPublicRedesign;
