import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getClient, updateClient, addGuardian, updateGuardian } from '@/api/client';
import { Button, Confirm, DateInput, Icon } from '@/ui';
import { formatPersonName, formatStatusLabel } from '@/lib/format';
import { US_STATES } from '@aba1on1/schemas';
import { ClientIntakeWizard } from './ClientIntakeWizard.jsx';

const EMPTY = {
  firstName: '', lastName: '', middleName: '', preferredName: '',
  dateOfBirth: '', email: '', phone: '', status: 'REFERRED', ssn: '',
  addressLine1: '', addressLine2: '', city: '', state: '', zip: '',
  parentFirstName: '', parentLastName: '', parentPhone: '', parentEmail: '', parentRelationship: 'PARENT',
};

const EDIT_STATUSES = ['REFERRED', 'INTAKE', 'ACTIVE', 'ON_HOLD', 'DISCHARGED'];
const REL_OPTS = [
  { value: 'PARENT', label: 'Parent' },
  { value: 'LEGAL_GUARDIAN', label: 'Legal guardian' },
  { value: 'FOSTER_PARENT', label: 'Foster parent' },
  { value: 'RELATIVE', label: 'Relative' },
  { value: 'OTHER', label: 'Other' },
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PARENT_INCOMPLETE = 'A parent needs a name, mobile number and email. Complete all three or clear the parent fields.';

/** Form sections — drive the section navigation and the per-section error dots. */
const SECTIONS = [
  { id: 'ce-client', label: 'Client details', desc: 'Legal name and date of birth', icon: Icon.Child, tone: 'violet', fields: ['firstName', 'middleName', 'lastName', 'preferredName', 'dateOfBirth'] },
  { id: 'ce-contact', label: 'Contact & status', desc: 'How to reach the client and their stage', icon: Icon.Shield, tone: 'blue', fields: ['email', 'phone', 'status', 'ssn'] },
  { id: 'ce-address', label: 'Address', desc: 'Home address for records', icon: Icon.Building, tone: 'teal', fields: ['addressLine1', 'addressLine2', 'city', 'state', 'zip'] },
  { id: 'ce-parent', label: 'Parent / Guardian', desc: 'Primary contact for communications', icon: Icon.Users, tone: 'amber', fields: ['parentFirstName', 'parentLastName', 'parentPhone', 'parentEmail', 'parentRelationship'] },
];

/**
 * Client form route.
 *
 * Add Client (/clients/new) is the step-wise intake (ClientIntakeWizard).
 * Edit Client keeps this single form: it loads the current record, updates the
 * existing primary parent in place (never a duplicate), blocks a half-entered
 * parent, and submits a versioned update with an If-Match header.
 */
export function ClientFormPage() {
  const { clientId } = useParams();
  if (!clientId) return <ClientIntakeWizard />;
  return <ClientEditForm clientId={clientId} />;
}

/** Client-side checks that mirror the server's updateClientSchema (never stricter). */
export function validateClientEdit(form) {
  const e = {};
  if (!form.firstName.trim()) e.firstName = 'First name is required.';
  else if (form.firstName.trim().length > 100) e.firstName = 'First name must be 100 characters or fewer.';
  if (!form.lastName.trim()) e.lastName = 'Last name is required.';
  else if (form.lastName.trim().length > 100) e.lastName = 'Last name must be 100 characters or fewer.';
  if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) e.email = 'Enter a valid email address.';
  if (form.phone.trim() && form.phone.trim().length < 3) e.phone = 'Enter a valid phone number.';
  if (form.ssn.trim() && form.ssn.trim().length < 4) e.ssn = 'SSN must be at least 4 characters.';
  if (form.zip.trim().length > 20) e.zip = 'ZIP code must be 20 characters or fewer.';
  const parentTouched = Boolean(form.parentFirstName || form.parentLastName || form.parentPhone || form.parentEmail);
  if (parentTouched) {
    if (!form.parentFirstName.trim()) e.parentFirstName = 'Required for a parent.';
    if (!form.parentLastName.trim()) e.parentLastName = 'Required for a parent.';
    if (!form.parentPhone.trim()) e.parentPhone = 'Required for a parent.';
    if (!form.parentEmail.trim()) e.parentEmail = 'Required for a parent.';
    else if (!EMAIL_RE.test(form.parentEmail.trim())) e.parentEmail = 'Enter a valid email address.';
  }
  return e;
}

function toForm(data) {
  const c = data.client;
  const a = c.address ?? {};
  // Load the existing parent (primary, else first) so Edit updates it in place.
  const guardians = data.guardians ?? [];
  const parent = guardians.find((g) => g.isPrimary) ?? guardians[0] ?? null;
  return {
    parentId: parent?.id ?? null,
    version: c.version,
    form: {
      ...EMPTY,
      firstName: c.firstName ?? '', lastName: c.lastName ?? '',
      middleName: c.middleName ?? '', preferredName: c.preferredName ?? '',
      dateOfBirth: c.dateOfBirth ? String(c.dateOfBirth).slice(0, 10) : '',
      email: c.email ?? '', phone: c.phone ?? '',
      status: c.status ?? 'REFERRED', ssn: c.ssn ?? '',
      addressLine1: a.line1 ?? '', addressLine2: a.line2 ?? '', city: a.city ?? '', state: a.state ?? '', zip: a.postalCode ?? '',
      parentFirstName: parent?.firstName ?? '', parentLastName: parent?.lastName ?? '',
      parentPhone: parent?.phone ?? '', parentEmail: parent?.email ?? '',
      parentRelationship: parent?.relationship ?? 'PARENT',
    },
  };
}

function ClientEditForm({ clientId }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [form, setForm] = useState(EMPTY);
  const [initial, setInitial] = useState(EMPTY);
  const [version, setVersion] = useState(null);
  const [parentId, setParentId] = useState(null); // existing primary guardian being edited (null → add)
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [showSsn, setShowSsn] = useState(false);
  const hydrated = useRef(false);

  const detail = useQuery({ queryKey: ['client', clientId], queryFn: () => getClient(clientId) });

  const hydrate = (data) => {
    const next = toForm(data);
    setForm(next.form); setInitial(next.form); setParentId(next.parentId); setVersion(next.version);
  };
  // Hydrate once — a background refetch must never overwrite in-progress edits.
  useEffect(() => {
    if (!detail.data || hydrated.current) return;
    hydrated.current = true;
    hydrate(detail.data);
  }, [detail.data]);

  const set = (key) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((cur) => (cur[key] ? { ...cur, [key]: undefined } : cur));
  };

  const dirty = Object.keys(EMPTY).some((k) => form[k] !== initial[k]);
  const parentTouched = Boolean(form.parentFirstName || form.parentLastName || form.parentPhone || form.parentEmail);
  const parentValid = Boolean(form.parentFirstName.trim() && form.parentLastName.trim() && form.parentPhone.trim() && form.parentEmail.trim());

  const buildBody = () => {
    const body = {};
    for (const key of ['middleName', 'preferredName', 'dateOfBirth', 'email', 'phone', 'status', 'ssn']) {
      const value = form[key].trim();
      if (value) body[key] = value;
    }
    // Names are stored properly cased via the shared formatter.
    if (form.firstName.trim()) body.firstName = formatPersonName(form.firstName);
    if (form.lastName.trim()) body.lastName = formatPersonName(form.lastName);
    // Structured US address: zip maps to the model's postalCode.
    const address = {};
    if (form.addressLine1.trim()) address.line1 = form.addressLine1.trim();
    if (form.addressLine2.trim()) address.line2 = form.addressLine2.trim();
    if (form.city.trim()) address.city = form.city.trim();
    if (form.state.trim()) address.state = form.state.trim();
    if (form.zip.trim()) address.postalCode = form.zip.trim();
    if (Object.keys(address).length > 0) body.address = address;
    return body;
  };

  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });

  const submit = async (event) => {
    event.preventDefault();
    setError(null); setConflict(false);
    const found = validateClientEdit(form);
    setFieldErrors(found);
    if (Object.keys(found).length) {
      // A half-entered parent is a validation error, not a silent drop.
      setError(parentTouched && !parentValid ? PARENT_INCOMPLETE : 'Please correct the highlighted fields.');
      const first = SECTIONS.find((s) => s.fields.some((f) => found[f]));
      if (first) scrollTo(first.id);
      return;
    }
    setSaving(true);
    try {
      const updated = await updateClient(clientId, buildBody(), version);
      // Parent persistence reuses the guardian API — PATCH in place, or add one.
      let savedGuardian = null;
      if (parentValid) {
        const parentBody = {
          firstName: formatPersonName(form.parentFirstName),
          lastName: formatPersonName(form.parentLastName),
          phone: form.parentPhone.trim(),
          email: form.parentEmail.trim(),
          relationship: form.parentRelationship,
        };
        savedGuardian = parentId
          ? await updateGuardian(clientId, parentId, parentBody)
          : await addGuardian(clientId, { ...parentBody, isPrimary: true });
      }
      // Show the saved values immediately, then refetch the authoritative record
      // (account status and alerts are derived on the server).
      queryClient.setQueryData(['client', clientId], (old) => {
        if (!old?.client) return old;
        const guardians = old.guardians ?? [];
        const nextGuardians = savedGuardian?.id
          ? (guardians.some((g) => g.id === savedGuardian.id) ? guardians.map((g) => (g.id === savedGuardian.id ? { ...g, ...savedGuardian } : g)) : [...guardians, savedGuardian])
          : guardians;
        return { ...old, client: { ...old.client, ...(updated ?? {}) }, guardians: nextGuardians };
      });
      // Background refetches — the profile opens at once from the updated cache.
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['client', clientId] });
      queryClient.invalidateQueries({ queryKey: ['child-alerts', clientId] });
      navigate(`/clients/${clientId}`);
    } catch (err) {
      const response = err?.response;
      const serverError = response?.data?.error;
      const code = serverError?.code;
      let message;
      if (response?.status === 409 && code === 'VERSION_CONFLICT') {
        message = 'This client changed since you loaded it. Reload and try again.';
        setConflict(true);
      } else if (code === 'CLIENT_ACTIVATION_REQUIRES_PARENT') {
        message = 'Add at least one parent (name, mobile and email) before activating this client.';
        setFieldErrors({ status: 'Add a parent before activating.' });
      } else if (response?.status === 422 && serverError?.details?.fieldErrors) {
        const fe = serverError.details.fieldErrors;
        setFieldErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k === 'address' ? 'addressLine1' : k, v?.[0]])));
        message = 'Please correct the highlighted fields.';
      } else if (typeof serverError?.message === 'string' && serverError.message.trim()) {
        message = serverError.message;
      } else {
        message = 'Could not save the client. Check the fields and try again.';
      }
      setError(message);
      setSaving(false);
    }
  };

  const reloadLatest = async () => {
    const res = await detail.refetch();
    if (res.data) { hydrate(res.data); setError(null); setConflict(false); setFieldErrors({}); }
  };

  const leave = () => (dirty ? setConfirmLeave(true) : navigate(`/clients/${clientId}`));

  if (detail.isLoading) {
    return (
      <div className="rx-ce" aria-busy="true" aria-label="Loading client">
        <div className="rx-skel" style={{ height: 96, borderRadius: 18 }} />
        <div className="rx-ce__layout"><div className="rx-skel rx-ce__nav-skel" /><div className="rx-skel" style={{ height: 420, borderRadius: 18 }} /></div>
      </div>
    );
  }
  if (detail.isError) {
    const notFound = [403, 404].includes(detail.error?.response?.status);
    return (
      <div className="rx-ce">
        <Link to="/clients" className="rx-sp__back"><Icon.Return size={15} /> Back to Clients</Link>
        <div className="rx-ce__state" role="alert">
          <span className="rx-ce__state-icon" aria-hidden="true"><Icon.Child size={22} /></span>
          <h1 className="rx-ce__state-title">{notFound ? 'Client not found' : 'We couldn’t load this client'}</h1>
          <p className="rx-ce__muted">{notFound ? 'This client doesn’t exist or isn’t available to you.' : 'Check your connection and try again.'}</p>
          {!notFound && <Button type="button" onClick={() => detail.refetch()}>Try again</Button>}
        </div>
      </div>
    );
  }

  const c = detail.data?.client ?? {};
  const displayName = [formatPersonName(form.firstName), formatPersonName(form.lastName)].filter(Boolean).join(' ') || 'Client';
  const initials = `${(form.firstName.trim()[0] ?? '').toUpperCase()}${(form.lastName.trim()[0] ?? '').toUpperCase()}` || 'C';
  const statuses = EDIT_STATUSES.includes(form.status) ? EDIT_STATUSES : [form.status, ...EDIT_STATUSES];
  const field = (key) => ({ value: form[key], onChange: set(key), 'aria-invalid': Boolean(fieldErrors[key]) || undefined });
  const sectionState = (s) => (s.fields.some((f) => fieldErrors[f]) ? 'error' : s.fields.some((f) => form[f] !== initial[f]) ? 'changed' : 'idle');

  return (
    <div className="rx-ce">
      <button type="button" className="rx-sp__back rx-ce__back" onClick={leave}><Icon.Return size={15} /> Back to client</button>

      <header className="rx-ce__hero">
        <div className="rx-ce__avatar" aria-hidden="true">{initials}</div>
        <div className="rx-ce__hero-text">
          <h1 className="rx-ce__title">Edit Client</h1>
          <p className="rx-ce__subtitle">
            <span className="rx-ce__subtitle-name">{displayName}</span>
            {c.clientNumber && <span>Client #{c.clientNumber}</span>}
            {c.accountStatus && <span>Account {formatStatusLabel(c.accountStatus)}</span>}
          </p>
        </div>
        <span className={`rx-ce__save-state rx-ce__save-state--${dirty ? 'dirty' : 'clean'}`} role="status">
          <span className="rx-ce__save-dot" aria-hidden="true" />{dirty ? 'Unsaved changes' : 'No changes yet'}
        </span>
      </header>

      <div className="rx-ce__layout">
        <nav className="rx-ce__nav" aria-label="Form sections">
          {SECTIONS.map((s) => {
            const state = sectionState(s);
            return (
              <button key={s.id} type="button" className={`rx-ce__nav-item rx-ce__nav-item--${s.tone}`} onClick={() => scrollTo(s.id)}>
                <span className="rx-ce__nav-icon" aria-hidden="true"><s.icon size={16} /></span>
                <span className="rx-ce__nav-text"><span className="rx-ce__nav-label">{s.label}</span><span className="rx-ce__nav-desc">{s.desc}</span></span>
                {state !== 'idle' && <span className={`rx-ce__nav-flag rx-ce__nav-flag--${state}`} aria-label={state === 'error' ? 'Needs attention' : 'Edited'} />}
              </button>
            );
          })}
        </nav>

        <form className="rx-ce__form" onSubmit={submit} noValidate>
          {error !== null && (
            <div className="rx-ce__alert" role="alert">
              <Icon.Bell size={16} aria-hidden="true" />
              <p className="form-error">{error}</p>
              {conflict && <Button type="button" size="sm" variant="subtle" onClick={reloadLatest} loading={detail.isFetching}>Load latest version</Button>}
            </div>
          )}

          <Section s={SECTIONS[0]}>
            <div className="rx-ce__grid rx-ce__grid--3">
              <Input label="First name" required error={fieldErrors.firstName}><input className="rx-ce__control" autoComplete="off" maxLength={100} {...field('firstName')} /></Input>
              <Input label="Middle name" hint="Optional" error={fieldErrors.middleName}><input className="rx-ce__control" autoComplete="off" maxLength={100} {...field('middleName')} /></Input>
              <Input label="Last name" required error={fieldErrors.lastName}><input className="rx-ce__control" autoComplete="off" maxLength={100} {...field('lastName')} /></Input>
            </div>
            <div className="rx-ce__grid">
              <Input label="Preferred name" hint="What the client likes to be called" error={fieldErrors.preferredName}><input className="rx-ce__control" autoComplete="off" maxLength={100} {...field('preferredName')} /></Input>
              <Input label="Date of birth" hint="MM/DD/YYYY" error={fieldErrors.dateOfBirth}>
                <DateInputField value={form.dateOfBirth} onChange={set('dateOfBirth')} />
              </Input>
            </div>
          </Section>

          <Section s={SECTIONS[1]}>
            <div className="rx-ce__grid">
              <Input label="Email" error={fieldErrors.email}><input className="rx-ce__control" type="email" autoComplete="off" {...field('email')} /></Input>
              <Input label="Phone" error={fieldErrors.phone}><input className="rx-ce__control" type="tel" autoComplete="off" maxLength={40} {...field('phone')} /></Input>
              <Input label="Status" hint="Referral stage. Account status (Active / Hold) is calculated automatically." error={fieldErrors.status}>
                <select className="rx-ce__control rx-ce__select" {...field('status')}>
                  {statuses.map((s) => <option key={s} value={s}>{formatStatusLabel(s)}</option>)}
                </select>
              </Input>
              <Input label="SSN" hint="Optional · stored encrypted" error={fieldErrors.ssn}>
                {/* Masked with CSS, not type="password", so browsers never autofill a saved login password here. */}
                <input className={`rx-ce__control rx-ce__control--pad-end${showSsn ? '' : ' rx-ce__control--masked'}`} type="text" autoComplete="off" spellCheck={false} maxLength={40} {...field('ssn')} />
                <button type="button" className="rx-ce__reveal" onClick={() => setShowSsn((v) => !v)} aria-label={showSsn ? 'Hide SSN' : 'Show SSN'}>
                  {showSsn ? <Icon.EyeOff size={16} /> : <Icon.Eye size={16} />}
                </button>
              </Input>
            </div>
          </Section>

          <Section s={SECTIONS[2]}>
            <div className="rx-ce__grid">
              <Input label="Address line 1" error={fieldErrors.addressLine1}><input className="rx-ce__control" autoComplete="off" maxLength={200} {...field('addressLine1')} /></Input>
              <Input label="Address line 2" hint="Apartment, suite, unit (optional)" error={fieldErrors.addressLine2}><input className="rx-ce__control" autoComplete="off" maxLength={200} {...field('addressLine2')} /></Input>
            </div>
            <div className="rx-ce__grid rx-ce__grid--3">
              <Input label="City" error={fieldErrors.city}><input className="rx-ce__control" autoComplete="off" maxLength={120} {...field('city')} /></Input>
              <Input label="State" error={fieldErrors.state}>
                <select className="rx-ce__control rx-ce__select" {...field('state')}>
                  <option value="">Select a state</option>
                  {US_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                </select>
              </Input>
              <Input label="ZIP code" error={fieldErrors.zip}><input className="rx-ce__control" inputMode="numeric" autoComplete="off" maxLength={20} {...field('zip')} /></Input>
            </div>
          </Section>

          <Section s={SECTIONS[3]} aside={
            parentValid ? <span className="rx-ce__pill rx-ce__pill--ok"><Icon.Check size={13} aria-hidden="true" /> Valid parent</span>
              : parentTouched ? <span className="rx-ce__pill rx-ce__pill--warn">Incomplete</span>
                : <span className="rx-ce__pill">No parent on file</span>
          }>
            <p className="rx-ce__info">
              <Icon.Bell size={15} aria-hidden="true" />
              <span>{parentId
                ? 'Update this parent’s details below. Changes save to the existing parent — no duplicate is created.'
                : 'Add at least one parent (name, mobile and email) so this client can be activated. You can also add parents later from the client’s page.'}</span>
            </p>
            <div className="rx-ce__grid">
              <Input label="Parent first name" required={parentTouched} error={fieldErrors.parentFirstName}><input className="rx-ce__control" autoComplete="off" {...field('parentFirstName')} /></Input>
              <Input label="Parent last name" required={parentTouched} error={fieldErrors.parentLastName}><input className="rx-ce__control" autoComplete="off" {...field('parentLastName')} /></Input>
              <Input label="Parent mobile number" required={parentTouched} error={fieldErrors.parentPhone}><input className="rx-ce__control" type="tel" autoComplete="off" placeholder="(555) 555-5555" {...field('parentPhone')} /></Input>
              <Input label="Parent email" required={parentTouched} error={fieldErrors.parentEmail}><input className="rx-ce__control" type="email" autoComplete="off" {...field('parentEmail')} /></Input>
              <Input label="Relationship" error={fieldErrors.parentRelationship}>
                <select className="rx-ce__control rx-ce__select" {...field('parentRelationship')}>
                  {REL_OPTS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </Input>
            </div>
          </Section>

          <div className="rx-ce__actions">
            <span className="rx-ce__actions-note">{dirty ? 'You have unsaved changes.' : 'Make changes, then save.'}</span>
            <Button type="button" variant="ghost" onClick={leave} disabled={saving}>Cancel</Button>
            <Button type="submit" icon={Icon.Check} loading={saving}>{saving ? 'Saving…' : 'Save Changes'}</Button>
          </div>
        </form>
      </div>

      <Confirm open={confirmLeave} tone="danger" title="Discard changes?" message="Your changes to this client have not been saved."
        confirmLabel="Discard changes" onCancel={() => setConfirmLeave(false)} onConfirm={() => { setConfirmLeave(false); navigate(`/clients/${clientId}`); }} />
    </div>
  );
}

function Section({ s, aside, children }) {
  return (
    <section id={s.id} className={`rx-ce__section rx-ce__section--${s.tone}`} aria-labelledby={`${s.id}-title`}>
      <div className="rx-ce__section-head">
        <span className="rx-ce__section-icon" aria-hidden="true"><s.icon size={18} /></span>
        <div className="rx-ce__section-text">
          <h2 id={`${s.id}-title`} className="rx-ce__section-title">{s.label}</h2>
          <p className="rx-ce__section-desc">{s.desc}</p>
        </div>
        {aside}
      </div>
      <div className="rx-ce__section-body">{children}</div>
    </section>
  );
}

/**
 * A labelled control. The label text is its own direct <span> and the control sits
 * inside the same <label>, so the label is always programmatically associated.
 */
function Input({ label, required, hint, error, children }) {
  return (
    <label className={`rx-ce__field${error ? ' rx-ce__field--error' : ''}`}>
      <span className="rx-ce__label">{label}</span>
      {required && <span className="rx-ce__req" aria-hidden="true">*</span>}
      <span className="rx-ce__control-wrap">{children}</span>
      {error ? <small className="rx-ce__err">{error}</small> : hint ? <small className="rx-ce__hint">{hint}</small> : null}
    </label>
  );
}

// The shared masked MM/DD/YYYY date field (never a native date input).
function DateInputField({ value, onChange }) {
  return <DateInput value={value} onChange={onChange} aria-label="Date of birth" />;
}
