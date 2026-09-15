import { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createClient, updateClient, getClient, addGuardian, updateGuardian,
  listServiceAuthorizations, createServiceAuthorization,
} from '@/api/client';
import { Card, Button, Icon, Field, TextInput, Select, DateInput, Modal, WizardPanel } from '@/ui';
import { formatDate, formatPersonName, todayLocalISO } from '@/lib/format';
import { US_STATES } from '@aba1on1/schemas';
import { InsurancePanelRedesign } from './redesign/InsurancePanelRedesign.jsx';

/**
 * ADD CLIENT — a five-step intake over the EXISTING client architecture:
 *
 *   1 Client · 2 Parent · 3 Address · 4 Insurance · 5 Authorization
 *
 * No new data model and no draft records. Steps 1–3 are held in the page and
 * persisted together by "Create Client" (POST /clients, then the guardian API
 * for the parent). Insurance and authorizations are the client's own records
 * with their own APIs, so steps 4–5 write them directly against the client that
 * now exists — the same endpoints the client page uses. Going Back after the
 * client exists updates it in place (If-Match version; the guardian is PATCHed,
 * never added twice).
 *
 * Business rules stay on the server and are only mirrored here:
 *  - a VALID parent is name + mobile + email; a client cannot be created ACTIVE
 *    and is activated from its page once a valid parent exists;
 *  - insurance and authorizations require a valid parent (PARENT_DETAILS_REQUIRED);
 *  - an authorization is saved the moment it is added. Its payer workflow
 *    (sent / approved) is the existing lifecycle on the client page — nothing
 *    here asks for or fakes an approval.
 */
export const INTAKE_STEPS = ['Client', 'Parent', 'Address', 'Insurance', 'Authorization'];
const STEP_TITLES = ['Client Information', 'Parent / Guardian Details', 'Address', 'Insurance', 'Authorization'];
const STEP_DESCRIPTIONS = [
  'Legal name and date of birth.',
  'The parent or guardian who receives communications.',
  'Home address for records and correspondence.',
  'Coverage details used for billing.',
  'ABA and FBA service authorizations.',
];
const STEP_TONES = ['violet', 'blue', 'teal', 'amber', 'green'];

const REL_OPTS = [
  { value: 'PARENT', label: 'Parent' },
  { value: 'LEGAL_GUARDIAN', label: 'Legal guardian' },
  { value: 'FOSTER_PARENT', label: 'Foster parent' },
  { value: 'RELATIVE', label: 'Relative' },
  { value: 'OTHER', label: 'Other' },
];
const STATE_OPTS = US_STATES.map((s) => ({ value: s.code, label: s.name }));
const SERVICE_OPTS = [{ value: 'ABA', label: 'ABA' }, { value: 'FBA', label: 'FBA' }];
const AUTH_STATUS_LABEL = { NOT_SENT: 'Not sent', SENT: 'Sent', APPROVED: 'Approved', DENIED: 'Denied' };

const EMPTY = {
  firstName: '', middleName: '', lastName: '', dateOfBirth: '',
  parentFirstName: '', parentLastName: '', parentPhone: '', parentEmail: '', parentRelationship: 'PARENT',
  addressLine1: '', addressLine2: '', city: '', state: '', zip: '',
};
const EMPTY_AUTH = () => ({ serviceType: 'ABA', authorizationNumber: '', billingCode: '', startDate: todayLocalISO(), endDate: '', units: '' });

const has = (v) => typeof v === 'string' && v.trim().length > 0;
/** Mirrors the server's ClientsService.isValidParent. */
export const isValidParent = (g) => Boolean(g) && [g.firstName, g.lastName, g.phone, g.email].every(has);
const serverMessage = (err, fallback) => {
  const m = err?.response?.data?.error?.message;
  return typeof m === 'string' && m.trim() ? m : fallback;
};

export function ClientIntakeWizard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null); // { id, version } once the client exists
  const [guardianId, setGuardianId] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e?.target ? e.target.value : e }));

  // The persisted client (after creation): the server's guardians decide whether
  // the parent prerequisite is met.
  const detail = useQuery({ queryKey: ['client', created?.id], queryFn: () => getClient(created.id), enabled: Boolean(created?.id) });
  const parentOnFile = (detail.data?.guardians ?? []).some(isValidParent);

  const parentTouched = [form.parentFirstName, form.parentLastName, form.parentPhone, form.parentEmail].some(has);
  const parentValid = isValidParent({ firstName: form.parentFirstName, lastName: form.parentLastName, phone: form.parentPhone, email: form.parentEmail });

  const clientBody = () => {
    const body = { firstName: formatPersonName(form.firstName), lastName: formatPersonName(form.lastName) };
    if (has(form.middleName)) body.middleName = formatPersonName(form.middleName);
    if (has(form.dateOfBirth)) body.dateOfBirth = form.dateOfBirth;
    const address = {};
    if (has(form.addressLine1)) address.line1 = form.addressLine1.trim();
    if (has(form.addressLine2)) address.line2 = form.addressLine2.trim();
    if (has(form.city)) address.city = form.city.trim();
    if (has(form.state)) address.state = form.state.trim();
    if (has(form.zip)) address.postalCode = form.zip.trim();
    if (Object.keys(address).length > 0) body.address = address;
    return body;
  };
  const parentBody = () => ({
    firstName: formatPersonName(form.parentFirstName),
    lastName: formatPersonName(form.parentLastName),
    phone: form.parentPhone.trim(),
    email: form.parentEmail.trim(),
    relationship: form.parentRelationship,
  });

  /**
   * Re-read the client after a guardian write. A detail fetch that started
   * BEFORE the write (the query mounts as soon as the client exists) would be
   * reused by a plain invalidate while no data is cached yet, leaving the
   * wizard with no parent on file — so cancel it first, then refetch.
   */
  const refreshClient = async (clientId) => {
    await qc.cancelQueries({ queryKey: ['client', clientId] });
    await qc.invalidateQueries({ queryKey: ['client', clientId] });
  };

  /** Create or update the ONE guardian this intake manages (never a second). */
  const saveParent = async (clientId) => {
    if (!parentValid) return;
    if (guardianId) {
      await updateGuardian(clientId, guardianId, parentBody());
    } else {
      const g = await addGuardian(clientId, { ...parentBody(), isPrimary: true });
      setGuardianId(g?.id ?? null);
    }
    await refreshClient(clientId);
  };

  const run = async (fn) => {
    setError(null);
    setBusy(true);
    try { await fn(); } catch (err) {
      setError(serverMessage(err, 'Could not save. Check the details and try again.'));
    } finally { setBusy(false); }
  };

  const next = () => run(async () => {
    if (step === 0) {
      if (!has(form.firstName) || !has(form.lastName)) { setError('Enter the client’s first and last name.'); return; }
      setStep(1);
      return;
    }
    if (step === 1) {
      if (parentTouched && !parentValid) { setError('A parent or guardian needs a first name, last name, mobile number and email.'); return; }
      if (created) await saveParent(created.id);
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!created) {
        // CREATE CLIENT — one POST for the client, then the guardian API.
        const result = await createClient(clientBody());
        setCreated({ id: result.id, version: result.version });
        await qc.invalidateQueries({ queryKey: ['clients'] });
        await saveParent(result.id);
      } else {
        const updated = await updateClient(created.id, clientBody(), created.version);
        setCreated({ id: created.id, version: updated?.version ?? created.version });
        // A parent whose save failed right after creation is retried here; the
        // server returns the existing guardian for an identical re-submit.
        if (!guardianId) await saveParent(created.id);
        await qc.invalidateQueries({ queryKey: ['client', created.id] });
      }
      setStep(3);
      return;
    }
    if (step === 3) { setStep(4); return; }
    navigate(`/clients/${created.id}`);
  });

  const back = () => { setError(null); setStep((s) => Math.max(0, s - 1)); };
  const primaryLabel = step === 2 ? (created ? 'Continue' : 'Create Client') : step === 4 ? 'Finish' : 'Continue';

  return (
    <div className="rx-ci">
      <Link to="/clients" className="rx-sp__back"><Icon.Return size={15} /> Back to Clients</Link>
      <header className="rx-ci__head">
        <h1 className="rx-ci__heading">Add Client</h1>
        <p className="rx-ci__subtitle">Create the client record, add a parent or guardian, then record insurance and authorizations.</p>
      </header>

      <div className="rx-ci__layout">
        <aside className="rx-ci__rail" aria-label="Progress">
          <div className="rx-ci__progress">
            <span>Step {step + 1} of {INTAKE_STEPS.length}</span>
            <span className="rx-ci__progress-bar" aria-hidden="true"><span style={{ width: `${((step + 1) / INTAKE_STEPS.length) * 100}%` }} /></span>
          </div>
          <ol className="rx-ci__steps">
            {INTAKE_STEPS.map((label, i) => {
              const state = i === step ? 'current' : i < step ? 'done' : 'todo';
              return (
                <li key={label} className={`rx-ci__step rx-ci__step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                  <span className="rx-ci__step-dot" aria-hidden="true">{state === 'done' ? <Icon.Check size={13} /> : i + 1}</span>
                  <span className="rx-ci__step-text">
                    <span className="rx-ci__step-label">{label}</span>
                    <span className="rx-ci__step-desc">{STEP_DESCRIPTIONS[i]}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          {created && (
            <div className="rx-ci__created" role="status">
              <Icon.CheckCircle size={16} aria-hidden="true" />
              <span>Client record created. You can add insurance and authorizations now or later.</span>
            </div>
          )}
        </aside>

        <Card className="rx-ci__card" pad={false}>
          <div className={`rx-ci__card-head rx-ci__card-head--${STEP_TONES[step]}`}>
            <span className="rx-ci__chip" aria-hidden="true">{step + 1}</span>
            <div>
              <h2 className="rx-ci__title">{STEP_TITLES[step]}</h2>
              <p className="rx-ci__title-desc">{STEP_DESCRIPTIONS[step]}</p>
            </div>
          </div>

          <div className="rx-ci__body">
            <AnimatePresence mode="wait">
            {step === 0 && (
              <WizardPanel key="client"><div className="rx-ci__grid">
                <Field label="First name" required><TextInput aria-label="First name" value={form.firstName} onChange={set('firstName')} autoFocus autoComplete="off" /></Field>
                <Field label="Middle name" hint="Optional"><TextInput aria-label="Middle name" value={form.middleName} onChange={set('middleName')} autoComplete="off" /></Field>
                <Field label="Last name" required><TextInput aria-label="Last name" value={form.lastName} onChange={set('lastName')} autoComplete="off" /></Field>
                <Field label="Date of birth" hint="Optional · MM/DD/YYYY"><DateInput value={form.dateOfBirth} onChange={set('dateOfBirth')} aria-label="Date of birth" /></Field>
              </div></WizardPanel>
            )}

            {step === 1 && (
              <WizardPanel key="parent">
                <p className="rx-ci__hint rx-ci__hint--info">
                  <Icon.Shield size={16} aria-hidden="true" />
                  A parent or guardian with a name, mobile number and email is required before insurance can be added or the client activated.
                </p>
                <div className="rx-ci__grid">
                  <Field label="First name" required><TextInput aria-label="Parent first name" value={form.parentFirstName} onChange={set('parentFirstName')} autoFocus /></Field>
                  <Field label="Last name" required><TextInput aria-label="Parent last name" value={form.parentLastName} onChange={set('parentLastName')} /></Field>
                  <Field label="Mobile number" required><TextInput aria-label="Parent mobile number" value={form.parentPhone} onChange={set('parentPhone')} placeholder="(555) 555-5555" inputMode="tel" autoComplete="tel" /></Field>
                  <Field label="Email" required><TextInput aria-label="Parent email" type="email" value={form.parentEmail} onChange={set('parentEmail')} autoComplete="email" /></Field>
                  <Field label="Relationship"><Select value={form.parentRelationship} onChange={set('parentRelationship')} options={REL_OPTS} searchable={false} /></Field>
                </div>
              </WizardPanel>
            )}

            {step === 2 && (
              <WizardPanel key="address"><div className="rx-ci__grid">
                <Field label="Address line 1"><TextInput aria-label="Address line 1" value={form.addressLine1} onChange={set('addressLine1')} autoFocus autoComplete="address-line1" /></Field>
                <Field label="Address line 2" hint="Optional"><TextInput aria-label="Address line 2" value={form.addressLine2} onChange={set('addressLine2')} autoComplete="address-line2" /></Field>
                <Field label="City"><TextInput aria-label="City" value={form.city} onChange={set('city')} autoComplete="address-level2" /></Field>
                <Field label="State"><Select value={form.state} onChange={set('state')} options={STATE_OPTS} placeholder="Select state" /></Field>
                <Field label="ZIP code"><TextInput aria-label="ZIP code" value={form.zip} onChange={set('zip')} inputMode="numeric" autoComplete="postal-code" /></Field>
              </div></WizardPanel>
            )}

            {step === 3 && created && (
              <WizardPanel key="insurance"><InsuranceStep clientId={created.id} parentOnFile={parentOnFile} loading={detail.isLoading} onAddParent={() => { setError(null); setStep(1); }} /></WizardPanel>
            )}

            {step === 4 && created && (
              <WizardPanel key="authorization"><AuthorizationStep clientId={created.id} parentOnFile={parentOnFile} loading={detail.isLoading} onAddParent={() => { setError(null); setStep(1); }} /></WizardPanel>
            )}
            </AnimatePresence>

            {error && <p className="rx-sf__banner rx-ci__error" role="alert"><Icon.Bell size={16} aria-hidden="true" />{error}</p>}
          </div>

          <div className="rx-ci__actions">
            {!created && <Button variant="ghost" onClick={() => navigate('/clients')} disabled={busy}>Cancel</Button>}
            <span className="rx-ci__spacer" />
            {step > 0 && <Button variant="ghost" onClick={back} disabled={busy}>Back</Button>}
            <Button onClick={next} loading={busy} icon={step === 4 ? Icon.Check : step === 2 && !created ? Icon.Plus : Icon.Arrow}>{primaryLabel}</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * Step 4. With a valid parent on file, the client's EXISTING insurance panel
 * (catalog/other insurer, member id, verification) is used as is. Without one,
 * adding insurance is refused with a prompt back to the parent step — the
 * server refuses it too.
 */
function InsuranceStep({ clientId, parentOnFile, loading, onAddParent }) {
  if (loading) return null;
  if (parentOnFile) return <InsurancePanelRedesign clientId={clientId} />;
  return (
    <ParentRequiredGate
      title="No insurance recorded"
      hint="Insurance can be added now or later from the client page."
      actionLabel="Add insurance"
      onAddParent={onAddParent}
    />
  );
}

/**
 * Shown in place of a parent-dependent step (insurance, authorization) while
 * the client has no valid parent. The action opens "Parent details required";
 * nothing is written and the client is never deleted. The server enforces the
 * same rule (PARENT_DETAILS_REQUIRED).
 */
function ParentRequiredGate({ title, hint, actionLabel, onAddParent }) {
  const [prompt, setPrompt] = useState(false);
  return (
    <>
      <div className="rx-ci__gate">
        <div>
          <div className="rx-ci__gate-title">{title}</div>
          <div className="rx-ci__hint">{hint}</div>
        </div>
        <Button icon={Icon.Plus} onClick={() => setPrompt(true)}>{actionLabel}</Button>
      </div>
      <Modal
        open={prompt}
        onClose={() => setPrompt(false)}
        title="Parent details required"
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setPrompt(false)}>Cancel</Button>
            <Button onClick={() => { setPrompt(false); onAddParent(); }}>Add parent details</Button>
          </>
        )}
      >
        <p style={{ margin: 0 }}>Please add the parent or guardian details before continuing.</p>
      </Modal>
    </>
  );
}

/**
 * Step 5. Enter details → Add Authorization → saved immediately → listed below,
 * usable at once (no review or approval). Needs a valid parent, like insurance.
 */
function AuthorizationStep({ clientId, parentOnFile, loading, onAddParent }) {
  if (loading) return null;
  if (!parentOnFile) {
    return (
      <ParentRequiredGate
        title="No authorizations added yet"
        hint="Authorizations can be added now or later from the client page."
        actionLabel="Add authorization"
        onAddParent={onAddParent}
      />
    );
  }
  return <AuthorizationForm clientId={clientId} />;
}

function AuthorizationForm({ clientId }) {
  const qc = useQueryClient();
  const [auth, setAuth] = useState(EMPTY_AUTH);
  const [err, setErr] = useState('');
  const list = useQuery({ queryKey: ['authorizations', clientId], queryFn: () => listServiceAuthorizations(clientId) });
  const setA = (k) => (e) => setAuth((a) => ({ ...a, [k]: e?.target ? e.target.value : e }));

  const add = useMutation({
    mutationFn: () => {
      const body = { serviceType: auth.serviceType };
      for (const k of ['authorizationNumber', 'billingCode', 'startDate', 'endDate']) if (has(auth[k])) body[k] = auth[k].trim();
      if (String(auth.units).trim() !== '') body.units = Number(auth.units);
      return createServiceAuthorization(clientId, body);
    },
    onSuccess: async (saved) => {
      setAuth(EMPTY_AUTH());
      // Saved on add (status NOT_SENT) — show it now, then refetch everything derived from it.
      if (saved?.id) qc.setQueryData(['authorizations', clientId], (cur) => (Array.isArray(cur) && !cur.some((a) => a.id === saved.id) ? [...cur, saved] : cur));
      await qc.invalidateQueries({ queryKey: ['authorizations', clientId] });
      qc.invalidateQueries({ queryKey: ['client', clientId] });
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['child-alerts', clientId] });
    },
    onError: (e) => setErr(serverMessage(e, 'Could not add the authorization.')),
  });

  const submit = () => {
    setErr('');
    if (auth.startDate && auth.endDate && auth.endDate < auth.startDate) { setErr('The end date must be on or after the start date.'); return; }
    add.mutate();
  };

  const items = list.data ?? [];
  return (
    <div className="rx-ci__auth">
      <div className="rx-ci__grid">
        <Field label="Service"><Select value={auth.serviceType} onChange={setA('serviceType')} options={SERVICE_OPTS} searchable={false} /></Field>
        <Field label="Authorization number"><TextInput aria-label="Authorization number" value={auth.authorizationNumber} onChange={setA('authorizationNumber')} /></Field>
        <Field label="Billing code"><TextInput aria-label="Billing code" value={auth.billingCode} onChange={setA('billingCode')} /></Field>
        <Field label="Start date" hint="MM/DD/YYYY"><DateInput value={auth.startDate} onChange={setA('startDate')} aria-label="Authorization start date" /></Field>
        <Field label="End date" hint="MM/DD/YYYY"><DateInput value={auth.endDate} onChange={setA('endDate')} aria-label="Authorization end date" /></Field>
        <Field label="Units" hint="1 unit = 15 min"><TextInput aria-label="Units" type="number" min="0" value={auth.units} onChange={setA('units')} /></Field>
      </div>
      {err && <p className="rx-formfield__err" role="alert">{err}</p>}
      <div className="rx-ci__row-end">
        <Button icon={Icon.Plus} variant="subtle" onClick={submit} loading={add.isPending}>Add Authorization</Button>
      </div>

      <div className="rx-ci__list" aria-label="Authorizations">
        {items.length === 0 ? (
          <div className="rx-ci__hint">No authorizations added yet.</div>
        ) : items.map((a) => (
          <div key={a.id} className="rx-ci__item">
            <div className="rx-ci__item-title">{a.serviceType}{a.authorizationNumber ? ` · #${a.authorizationNumber}` : ''}</div>
            <div className="rx-ci__hint">
              {[a.startDate || a.endDate ? `${a.startDate ? formatDate(String(a.startDate).slice(0, 10)) : '—'} – ${a.endDate ? formatDate(String(a.endDate).slice(0, 10)) : '—'}` : null,
                a.units != null ? `${a.units} units` : null,
                AUTH_STATUS_LABEL[a.status] ?? null].filter(Boolean).join(' · ')}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ClientIntakeWizard;
