import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createStaff } from '@/api/client';
import { usePermissions } from '@/auth/permissions';
import { useToast } from '@/components';
import { Button, Card, DateInput, Field, Icon, TextInput } from '@/ui';
import { formatFullName } from '@/lib/format';

/**
 * ADD STAFF — creates a BCBA or RBT through the existing POST /v1/staff.
 *
 * The server provisions the login account (temporary password, ACTIVE
 * membership in the caller's tenant), creates the linked staff profile, stores
 * the hourly pay rate on the PayRate model and queues the welcome email. The
 * browser sends only the fields the create schema accepts — role, names,
 * email, optional start date and pay rate — never a tenant, user id, employee
 * ID or status (new staff start Active). Server validation stays authoritative:
 * its field errors and duplicate-email conflict are shown inline.
 */

const ROLES = [
  { key: 'bcba', name: 'BCBA', tag: 'Board Certified Behavior Analyst', icon: Icon.Shield,
    desc: 'Supervises caseloads, writes treatment plans and signs off sessions.' },
  { key: 'rbt', name: 'RBT', tag: 'Registered Behavior Technician', icon: Icon.User,
    desc: 'Delivers sessions to assigned clients and records session data.' },
];
const EMPTY = { roleKey: '', firstName: '', middleName: '', lastName: '', email: '', startDate: '', hourlyPayRate: '' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_ORDER = ['roleKey', 'firstName', 'middleName', 'lastName', 'email', 'startDate', 'hourlyPayRate'];

/** Client-side checks mirroring the server's create schema (the server re-validates). */
export function validateStaffForm(form) {
  const e = {};
  if (!form.roleKey) e.roleKey = 'Choose a role.';
  if (!form.firstName.trim()) e.firstName = 'First name is required.';
  else if (form.firstName.trim().length > 100) e.firstName = 'First name must be 100 characters or fewer.';
  if (!form.lastName.trim()) e.lastName = 'Last name is required.';
  else if (form.lastName.trim().length > 100) e.lastName = 'Last name must be 100 characters or fewer.';
  if (form.middleName.trim().length > 80) e.middleName = 'Middle name must be 80 characters or fewer.';
  if (!form.email.trim()) e.email = 'Email is required — the login invitation is sent here.';
  else if (!EMAIL_RE.test(form.email.trim())) e.email = 'Enter a valid email address.';
  const rate = String(form.hourlyPayRate).trim();
  if (rate !== '' && (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 10000)) {
    e.hourlyPayRate = 'Enter an hourly rate between 0 and 10,000.';
  }
  return e;
}

/** The exact create body: only fields the API accepts, trimmed; optional ones only when filled. */
export function buildCreateStaffBody(form) {
  const body = {
    roleKey: form.roleKey,
    firstName: form.firstName.trim(),
    lastName: form.lastName.trim(),
    email: form.email.trim().toLowerCase(),
  };
  if (form.middleName.trim()) body.middleName = form.middleName.trim();
  if (form.startDate) body.startDate = form.startDate;
  if (String(form.hourlyPayRate).trim() !== '') body.hourlyPayRate = Number(form.hourlyPayRate);
  return body;
}

/** Map an API error to { fields, banner } without inventing messages the server didn't send. */
export function apiErrorToForm(err) {
  const status = err?.response?.status;
  const error = err?.response?.data?.error ?? {};
  const serverMessage = typeof error.message === 'string' && !/^[A-Z_]+-?\d*$/.test(error.message) ? error.message : null;
  if (status === 409) {
    return { fields: { email: serverMessage ?? 'An account already exists for that email address.' }, banner: null };
  }
  if (status === 422 && error.details?.fieldErrors) {
    const fields = {};
    for (const [key, messages] of Object.entries(error.details.fieldErrors)) {
      if (Array.isArray(messages) && messages.length) fields[key] = messages[0];
    }
    if (Object.keys(fields).length) return { fields, banner: 'Please correct the highlighted fields.' };
  }
  if (status === 403) return { fields: {}, banner: serverMessage ?? 'You don’t have permission to add staff.' };
  return { fields: {}, banner: serverMessage ?? 'The staff member could not be created. Please try again.' };
}

export function AddStaffForm() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { permissions, ready } = usePermissions();
  const canManage = permissions.includes('staff.manage');
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [created, setCreated] = useState(null); // { staff, emailQueued, form }
  const inFlight = useRef(false);
  const formRef = useRef(null);

  const set = (key) => (e) => {
    const value = typeof e === 'string' ? e : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((cur) => (cur[key] ? { ...cur, [key]: undefined } : cur));
  };

  const mutation = useMutation({
    mutationFn: (body) => createStaff(body),
    onSuccess: async (result, body) => {
      // Refresh every staff query (the Staff list included) — no reload.
      await qc.invalidateQueries({ queryKey: ['staff'] });
      toast.push('Staff member created.');
      setCreated({ staff: result, emailQueued: result?.emailQueued === true, body });
    },
    onError: (err) => {
      const { fields, banner: message } = apiErrorToForm(err);
      setErrors(fields);
      setBanner(message);
      focusFirstError(fields);
    },
    onSettled: () => { inFlight.current = false; },
  });

  function focusFirstError(errs) {
    const first = FIELD_ORDER.find((k) => errs[k]);
    if (!first || !formRef.current) return;
    const el = formRef.current.querySelector(`[data-field="${first}"]`);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    el?.focus?.();
  }

  function submit(e) {
    e.preventDefault();
    if (inFlight.current || mutation.isPending) return; // one click → one POST
    const found = validateStaffForm(form);
    setErrors(found);
    setBanner(Object.keys(found).length ? 'Please complete the required fields.' : null);
    if (Object.keys(found).length) { focusFirstError(found); return; }
    inFlight.current = true;
    mutation.mutate(buildCreateStaffBody(form));
  }

  function addAnother() {
    setForm(EMPTY); setErrors({}); setBanner(null); setCreated(null); mutation.reset();
  }

  if (ready && !canManage) {
    return (
      <div className="rx-sf">
        <Link to="/staff" className="rx-sp__back"><Icon.Return size={15} /> Back to Staff</Link>
        <Card className="rx-sf__notice">
          <span className="rx-sf__notice-icon" aria-hidden="true"><Icon.Shield size={22} /></span>
          <h1 className="rx-sf__notice-title">You can’t add staff</h1>
          <p className="rx-sf__muted">Adding staff requires permission to manage staff. Ask your company administrator.</p>
        </Card>
      </div>
    );
  }

  if (created) {
    const role = ROLES.find((r) => r.key === created.body.roleKey);
    const name = formatFullName({ firstName: created.body.firstName, middleName: created.body.middleName, lastName: created.body.lastName });
    return (
      <div className="rx-sf" role="status" aria-live="polite">
        <Card className="rx-sf__success">
          <span className="rx-sf__success-icon" aria-hidden="true"><Icon.CheckCircle size={30} /></span>
          <h1 className="rx-sf__success-title">{name} has been added</h1>
          <p className="rx-sf__muted">
            {role?.name} account created{created.staff?.employeeNumber ? ` · Employee ID ${created.staff.employeeNumber}` : ''}.
          </p>
          <p className={`rx-sf__delivery${created.emailQueued ? '' : ' rx-sf__delivery--warn'}`}>
            {created.emailQueued
              ? <>Login instructions are on their way to <strong>{created.body.email}</strong>.</>
              : <>The login email could not be queued. Open the profile and use <strong>Resend login email</strong>.</>}
          </p>
          <div className="rx-sf__success-actions">
            {created.staff?.id && <Button onClick={() => navigate(`/staff/${created.staff.id}`)}>View profile</Button>}
            <Button variant="ghost" icon={Icon.Plus} onClick={addAnother}>Add another</Button>
            <Button variant="ghost" onClick={() => navigate('/staff')}>Back to Staff</Button>
          </div>
        </Card>
      </div>
    );
  }

  const selectedRole = ROLES.find((r) => r.key === form.roleKey);
  const previewName = formatFullName({ firstName: form.firstName, middleName: form.middleName, lastName: form.lastName });

  return (
    <div className="rx-sf">
      <Link to="/staff" className="rx-sp__back"><Icon.Return size={15} /> Back to Staff</Link>
      <header className="rx-sf__head">
        <h1 className="rx-sf__title">Add staff member</h1>
        <p className="rx-sf__subtitle">Create a BCBA or RBT account. They’ll receive an email with instructions to sign in.</p>
      </header>

      <form ref={formRef} className="rx-sf__layout" onSubmit={submit} noValidate aria-label="Add staff member">
        <div className="rx-sf__main">
          {banner && <div className="rx-sf__banner" role="alert"><Icon.Bell size={16} aria-hidden="true" />{banner}</div>}

          <FormSection step="1" tone="violet" title="Role" description="Choose what this person does. Their role sets what they can see and do." required>
            <div className="rx-sf__roles" role="radiogroup" aria-label="Role" aria-required="true" aria-invalid={Boolean(errors.roleKey)}>
              {ROLES.map((r, i) => {
                const checked = form.roleKey === r.key;
                return (
                  <button key={r.key} type="button" role="radio" aria-checked={checked} data-field={i === 0 ? 'roleKey' : undefined}
                    className={`rx-sf__role rx-sf__role--${r.key}${checked ? ' is-selected' : ''}`}
                    onClick={() => set('roleKey')(r.key)}>
                    <span className="rx-sf__role-icon" aria-hidden="true"><r.icon size={22} /></span>
                    <span className="rx-sf__role-text">
                      <span className="rx-sf__role-name">{r.name}</span>
                      <span className="rx-sf__role-tag">{r.tag}</span>
                      <span className="rx-sf__role-desc">{r.desc}</span>
                    </span>
                    <span className="rx-sf__role-check" aria-hidden="true">{checked && <Icon.Check size={14} />}</span>
                  </button>
                );
              })}
            </div>
            {errors.roleKey && <p className="rx-formfield__err rx-sf__err">{errors.roleKey}</p>}
          </FormSection>

          <FormSection step="2" tone="teal" title="Personal information" description="The staff member’s legal name and the email they’ll sign in with.">
            <div className="rx-sf__grid">
              <Field label="First name" htmlFor="sf-first" required error={errors.firstName}>
                <TextInput id="sf-first" data-field="firstName" value={form.firstName} onChange={set('firstName')} autoComplete="given-name" error={errors.firstName} aria-invalid={Boolean(errors.firstName)} />
              </Field>
              <Field label="Middle name" htmlFor="sf-middle" hint="Optional" error={errors.middleName}>
                <TextInput id="sf-middle" data-field="middleName" value={form.middleName} onChange={set('middleName')} autoComplete="additional-name" error={errors.middleName} aria-invalid={Boolean(errors.middleName)} />
              </Field>
              <Field label="Last name" htmlFor="sf-last" required error={errors.lastName}>
                <TextInput id="sf-last" data-field="lastName" value={form.lastName} onChange={set('lastName')} autoComplete="family-name" error={errors.lastName} aria-invalid={Boolean(errors.lastName)} />
              </Field>
              <Field label="Work email" htmlFor="sf-email" required error={errors.email} hint="Used to sign in. The invitation is sent here.">
                <TextInput id="sf-email" data-field="email" type="email" value={form.email} onChange={set('email')} autoComplete="email" inputMode="email" error={errors.email} aria-invalid={Boolean(errors.email)} />
              </Field>
            </div>
          </FormSection>

          <FormSection step="3" tone="amber" title="Employment details" description="Optional — you can add or change these later from the staff profile.">
            <div className="rx-sf__grid">
              <Field label="Start date" hint="Optional · MM/DD/YYYY" error={errors.startDate}>
                <span data-field="startDate"><DateInput value={form.startDate} onChange={set('startDate')} aria-label="Start date" /></span>
              </Field>
              <Field label="Hourly pay rate" htmlFor="sf-rate" hint="Optional · used for payroll" error={errors.hourlyPayRate}>
                <TextInput id="sf-rate" data-field="hourlyPayRate" type="number" min="0" max="10000" step="0.01" inputMode="decimal" value={form.hourlyPayRate} onChange={set('hourlyPayRate')} error={errors.hourlyPayRate} aria-invalid={Boolean(errors.hourlyPayRate)} icon={Icon.Wallet} />
              </Field>
            </div>
          </FormSection>

          <div className="rx-sf__actions">
            <Button variant="ghost" onClick={() => navigate('/staff')} disabled={mutation.isPending}>Cancel</Button>
            <Button type="submit" icon={Icon.Check} loading={mutation.isPending} disabled={mutation.isPending}>
              {mutation.isPending ? 'Creating…' : 'Create staff member'}
            </Button>
          </div>
        </div>

        <aside className="rx-sf__aside" aria-label="Summary">
          <Card className="rx-sf__preview">
            <div className={`rx-sf__preview-avatar rx-sf__preview-avatar--${form.roleKey || 'none'}`} aria-hidden="true">
              {`${form.firstName.trim()[0] ?? ''}${form.lastName.trim()[0] ?? ''}`.toUpperCase() || <Icon.User size={22} />}
            </div>
            <div className="rx-sf__preview-name">{previewName || 'New staff member'}</div>
            <div className="rx-sf__preview-meta">{selectedRole ? selectedRole.name : 'Role not selected'}{form.email.trim() ? ` · ${form.email.trim()}` : ''}</div>
            <ol className="rx-sf__next">
              <li><Icon.CheckCircle size={16} aria-hidden="true" /><span>An account is created in your organization and set to Active.</span></li>
              <li><Icon.Doc size={16} aria-hidden="true" /><span>A welcome email with a temporary password is sent to the work email.</span></li>
              <li><Icon.Users size={16} aria-hidden="true" /><span>They appear in your Staff list right away.</span></li>
            </ol>
          </Card>
        </aside>
      </form>
    </div>
  );
}

function FormSection({ step, tone, title, description, required, children }) {
  return (
    <section className={`rx-sf__section rx-sf__section--${tone}`} aria-labelledby={`sf-sec-${step}`}>
      <div className="rx-sf__section-head">
        <span className="rx-sf__step" aria-hidden="true">{step}</span>
        <div>
          <h2 className="rx-sf__section-title" id={`sf-sec-${step}`}>{title}{required && <span className="rx-req">*</span>}</h2>
          <p className="rx-sf__section-desc">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export default AddStaffForm;
