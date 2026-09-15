import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getOrganizationProfile,
  updateOrganizationProfile,
  fetchBranding,
  uploadTenantLogo,
  changePassword,
} from '@/api/client';
import { useToast } from '@/components';
import { Card, Button, Icon, Badge, ErrorState } from '@/ui';
import { Field, TextInput, Select } from '@/ui/components/index.js';
import { StateMultiSelect } from '@/components/StateMultiSelect.jsx';
import { usePermissions } from '@/auth/permissions';
import { useAuthStore } from '@/auth/store';
import { statusLabel } from '@/lib/format';
import { timeZoneLabel, timeZoneOptions } from '@/lib/timezones.js';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * Company Profile — one consolidated page: the company's details (company,
 * contact, address, operating states), company settings (the organization time
 * zone), organization details, branding and account security. Laid out with the Staff / Client pages' header and the Add
 * Staff form's section cards, two-column field grid and summary aside.
 *
 * API (unchanged): GET /v1/organization reads the caller's own profile and
 * PATCH /v1/organization (If-Match: version) saves ONLY the changed editable
 * fields. The server derives the tenant from the session — the browser never
 * sends an organizationId.
 *
 * Security-critical rule: the PRIMARY (login) email is shown read-only and can
 * never be edited here. It is not in the editable set, so it is never sent in a
 * PATCH; the backend also drops it from the update schema. The editable public
 * address is the separate "Contact email" (contactEmail).
 *
 * Editing is offered only to a user holding organization.update; anyone else
 * sees the same profile read-only (the change-password form is their own).
 */

// Editable fields ONLY. primaryContactEmail (login identity) is intentionally
// excluded — it is rendered locked and never patched.
const REQUIRED_FIELDS = ['tradingName', 'primaryContactName'];
const CLEARABLE_FIELDS = ['contactEmail', 'contactPhone', 'websiteUrl', 'addressLine1', 'addressLine2', 'city', 'postalCode'];
const EDITABLE_FIELDS = [...REQUIRED_FIELDS, ...CLEARABLE_FIELDS];

const LABELS = {
  tradingName: 'Company name',
  primaryContactName: 'Primary contact name',
  contactEmail: 'Contact email',
  contactPhone: 'Phone',
  websiteUrl: 'Website',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  postalCode: 'ZIP / postal code',
};
const INPUT_TYPE = { contactEmail: 'email', contactPhone: 'tel', websiteUrl: 'url' };
const AUTOCOMPLETE = { tradingName: 'organization', contactEmail: 'email', contactPhone: 'tel', websiteUrl: 'url', addressLine1: 'address-line1', addressLine2: 'address-line2', city: 'address-level2', postalCode: 'postal-code', primaryContactName: 'name' };
const STATE_TONE = { ACTIVE: 'approved', SUSPENDED: 'denied', OFFBOARDING: 'pending', PENDING: 'pending' };

function toForm(profile) {
  const form = {};
  for (const key of EDITABLE_FIELDS) form[key] = profile?.[key] ?? '';
  // Operating states (spec Module 5.3) — an array, kept alongside the text
  // fields but handled separately since it isn't a trimmed string value.
  form.serviceStates = Array.isArray(profile?.serviceStates) ? [...profile.serviceStates] : [];
  // The organization time zone — an IANA identifier (never a display label).
  form.timezone = profile?.timezone ?? '';
  return form;
}

function buildPatch(form, original) {
  const patch = {};
  for (const key of EDITABLE_FIELDS) {
    const next = form[key].trim();
    const prev = (original?.[key] ?? '').toString();
    if (next === prev) continue;
    if (next === '') { if (CLEARABLE_FIELDS.includes(key)) patch[key] = null; }
    else patch[key] = next;
  }
  // Operating states: include only when the set actually changed. Sorting makes
  // the comparison order-insensitive (the picker appends in click order).
  const nextStates = [...(form.serviceStates ?? [])].sort();
  const prevStates = [...(original?.serviceStates ?? [])].sort();
  if (nextStates.length !== prevStates.length || nextStates.some((s, i) => s !== prevStates[i])) {
    patch.serviceStates = nextStates;
  }
  if (form.timezone && form.timezone !== (original?.timezone ?? '')) patch.timezone = form.timezone;
  return patch;
}

const ACCEPTED_LOGO = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
/** A plain-language message for a failed save (validation, permission, conflict, network). */
function saveErrorMessage(error) {
  const status = error?.response?.status;
  if (error?.request && !error?.response) return 'We couldn’t reach the server. Check your connection and try again.';
  if (status === 403) return 'You don’t have permission to change the company profile.';
  if (status === 409 || status === 412) return 'The company profile was changed by someone else. Reload the page and try again.';
  if (status === 422 || status === 400) return 'Some details are not valid. Check the highlighted fields and try again.';
  return 'Could not save the company profile. Please try again.';
}

const initials = (value) => String(value || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '·';

export function CompanyProfileRedesign() {
  const qc = useQueryClient();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const canEdit = ready && can('organization.update');
  const applyOrganizationTimezone = useAuthStore((s) => s.applyOrganizationTimezone);
  const refreshPrincipal = useAuthStore((s) => s.refreshPrincipal);
  const query = useQuery({ queryKey: ['org-profile'], queryFn: getOrganizationProfile });
  const brandingQuery = useQuery({ queryKey: ['org-branding-logo'], queryFn: fetchBranding });

  const profile = query.data;
  const [form, setForm] = useState(() => toForm(profile));
  const [errors, setErrors] = useState({});
  const [logoError, setLogoError] = useState(null);

  useEffect(() => { if (profile) setForm(toForm(profile)); }, [profile]);

  const save = useMutation({
    mutationFn: (patch) => updateOrganizationProfile(patch, profile.version),
    onSuccess: (updated, patch) => {
      qc.setQueryData(['org-profile'], updated);
      // Organization time zone: adopt the value the server confirmed so every
      // date and time re-renders in it now, then re-read /auth/me (the source
      // of organizationTimezone). Cached server data is refetched when the zone
      // changes (OrganizationTimezoneSync).
      if (patch.timezone && updated?.timezone) {
        applyOrganizationTimezone(updated.timezone);
        refreshPrincipal().catch(() => { /* the confirmed value is already applied */ });
      }
      qc.invalidateQueries({ queryKey: ['org-branding'] });
      qc.invalidateQueries({ queryKey: ['branding'] });
      // Operating (service) states drive which global insurance companies are
      // eligible in the Client → Add Insurance dropdown (spec §10). A change here
      // must refetch that state-filtered catalog so the picker is never stale.
      qc.invalidateQueries({ queryKey: ['insurance-catalog'] });
      toast.push('Company profile saved.');
    },
    onError: (error) => {
      const fieldErrors = error?.response?.data?.error?.details?.fieldErrors ?? {};
      if (fieldErrors.timezone?.length) setErrors((prev) => ({ ...prev, timezone: 'Choose a valid time zone.' }));
      toast.push(saveErrorMessage(error), 'negative');
    },
  });

  const logo = useMutation({
    mutationFn: (dataUrl) => uploadTenantLogo(dataUrl),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-branding-logo'] });
      qc.invalidateQueries({ queryKey: ['org-branding'] });
      qc.invalidateQueries({ queryKey: ['branding'] });
      toast.push('Logo updated.');
    },
    onError: () => toast.push('Could not upload the logo. Please try again.', 'negative'),
  });

  function set(key) { return (e) => setForm((f) => ({ ...f, [key]: e.target.value })); }

  function validate() {
    const next = {};
    for (const key of REQUIRED_FIELDS) if (!form[key].trim()) next[key] = 'This field is required.';
    if (form.contactEmail.trim() && !/^\S+@\S+\.\S+$/.test(form.contactEmail.trim())) next.contactEmail = 'Enter a valid email address.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function onSubmit(e) {
    e.preventDefault();
    if (!profile || !canEdit || save.isPending) return;
    if (!validate()) return;
    const patch = buildPatch(form, profile);
    if (Object.keys(patch).length === 0) { toast.push('No changes to save.'); return; }
    save.mutate(patch);
  }

  function onDiscard() {
    setForm(toForm(profile));
    setErrors({});
  }

  function onLogoFile(file) {
    setLogoError(null);
    if (!file) return;
    if (!ACCEPTED_LOGO.includes(file.type)) { setLogoError('Please choose a PNG, JPG or WebP image.'); return; }
    if (file.size > MAX_LOGO_BYTES) { setLogoError('That image is too large. Please use a logo under 2 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => logo.mutate(String(reader.result));
    reader.onerror = () => setLogoError('We couldn’t read that file. Please try another.');
    reader.readAsDataURL(file);
  }

  const dirty = Boolean(profile) && Object.keys(buildPatch(form, profile)).length > 0;
  const logoUrl = brandingQuery.data?.logoUrl ?? null;

  const input = (key, { full = false } = {}) => (
    <div className={full ? 'rx-cpf__full' : undefined}>
      <Field label={LABELS[key]} htmlFor={`cp-${key}`} required={canEdit && REQUIRED_FIELDS.includes(key)} error={errors[key]}>
        <TextInput
          id={`cp-${key}`} name={key} type={INPUT_TYPE[key] ?? 'text'}
          value={form[key]} onChange={set(key)} error={!!errors[key]} autoComplete={AUTOCOMPLETE[key] ?? 'off'}
          readOnly={!canEdit} disabled={!canEdit}
        />
      </Field>
    </div>
  );

  return (
    <div className="rx-cpf">
      <header className="rx-st__head">
        <div className="rx-st__head-text">
          <h1 className="rx-st__title">Company Profile</h1>
          <p className="rx-st__subtitle">Your organization’s details, contact information, branding and account security.</p>
        </div>
        {profile?.state && <Badge tone={STATE_TONE[profile.state] ?? 'draft'}>{statusLabel(profile.state)}</Badge>}
      </header>

      {query.isLoading ? <ProfileSkeleton /> : query.isError ? (
        <Card pad={false}><ErrorState title="We couldn’t load the company profile" body="Please try again in a moment." onRetry={() => query.refetch()} /></Card>
      ) : profile && (
        <>
        <nav className="rx-cpf__index" aria-label="Company profile sections">
          {[['cp-company', 'Company information'], ['cp-settings', 'Company settings'], ['cp-contact', 'Contact'], ['cp-address', 'Address'], ['cp-states', 'Operating states'], ['cp-security', 'Account security']].map(([id, label]) => (
            <button key={id} type="button" className="rx-cpf__index-link" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>{label}</button>
          ))}
        </nav>
        <div className="rx-sf__layout rx-cpf__layout">
          <div className="rx-sf__main">
            {!canEdit && ready && (
              <div className="rx-cpf__notice" role="note"><Icon.Shield size={16} aria-hidden="true" /> You can view the company profile. Editing requires permission to update the organization.</div>
            )}
            <form className="rx-sf__main" onSubmit={onSubmit} noValidate aria-label="Company profile">
              <Section icon={Icon.Building} tone="violet" id="cp-company" title="Company information" description={`How your company appears across ${PLATFORM_BRAND.productName}.`}>
                <div className="rx-sf__grid">
                  {input('tradingName')}
                  <ReadOnlyField id="cp-legal" label="Legal name" value={profile.legalName} hint="Set during onboarding." />
                  {input('websiteUrl', { full: true })}
                </div>
              </Section>

              <Section icon={Icon.Clock} tone="teal" id="cp-settings" title="Company settings" description="Settings that apply to everyone in your organization.">
                <div className="rx-sf__grid">
                  <div className="rx-cpf__full">
                    <Field label="Time zone" htmlFor="cp-timezone" required={canEdit} error={errors.timezone}
                      hint="Used for dates, schedules, sessions, payroll and billing across your organization.">
                      <Select id="cp-timezone" portal searchable={false} value={form.timezone} disabled={!canEdit || save.isPending}
                        options={timeZoneOptions(profile.timezone)} placeholder="Select a time zone"
                        onChange={(next) => { setForm((f) => ({ ...f, timezone: next })); setErrors((prev) => ({ ...prev, timezone: undefined })); }} />
                    </Field>
                  </div>
                </div>
              </Section>

              <Section icon={Icon.User} tone="teal" id="cp-contact" title="Contact information" description="The primary contact and the public contact details for your company.">
                <div className="rx-sf__grid">
                  {input('primaryContactName')}
                  <div>
                    {/* Primary (login) email — locked, read-only, never editable. */}
                    <Field label="Primary email" hint="Your account’s login email. It cannot be changed here.">
                      <div className="rx-input rx-cpf__locked" aria-readonly="true">
                        <input value={profile.primaryContactEmail ?? ''} readOnly disabled aria-label="Primary email (locked)" />
                        <span className="rx-cpf__lock"><Icon.Shield size={12} aria-hidden="true" /> Locked</span>
                      </div>
                    </Field>
                  </div>
                  {input('contactEmail')}
                  {input('contactPhone')}
                </div>
              </Section>

              <Section icon={Icon.Grid} tone="amber" id="cp-address" title="Address" description="Your company’s mailing address.">
                <div className="rx-sf__grid">
                  {input('addressLine1', { full: true })}
                  {input('addressLine2', { full: true })}
                  {input('city')}
                  {input('postalCode')}
                </div>
              </Section>

              <Section icon={Icon.Shield} tone="violet" id="cp-states" title="Operating states" description="The US states you provide services in. Changing them updates which insurance companies you can pick for new client insurance; existing client records are never affected.">
                <StateMultiSelect
                  value={form.serviceStates}
                  onChange={(next) => setForm((f) => ({ ...f, serviceStates: next }))}
                  disabled={!canEdit}
                />
              </Section>

              {canEdit && (
                <div className="rx-sf__actions rx-cpf__actions">
                  <span className="rx-cpf__dirty" aria-live="polite">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
                  <Button type="button" variant="ghost" onClick={onDiscard} disabled={!dirty || save.isPending}>Discard changes</Button>
                  <Button type="submit" icon={Icon.Check} loading={save.isPending}>
                    {save.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                </div>
              )}
            </form>

            <ChangePasswordCard />
          </div>

          <aside className="rx-sf__aside rx-cpf__aside" aria-label="Company summary">
            <Card className="rx-sf__preview rx-cpf__summary">
              <div className="rx-cpf__logo">
                {logoUrl ? <img src={logoUrl} alt="Company logo" /> : <span className="rx-cpf__logo-initials" aria-hidden="true">{initials(profile.tradingName)}</span>}
              </div>
              <div className="rx-sf__preview-name">{profile.tradingName || 'Company name not set'}</div>
              <div className="rx-sf__preview-meta">{profile.legalName || 'Legal name not set'}</div>
              {canEdit && (
                <div className="rx-cpf__logo-actions">
                  <label className="rx-btn rx-btn--ghost rx-cpf__upload">
                    <Icon.Plus size={16} /> {logo.isPending ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
                    <input type="file" accept={ACCEPTED_LOGO.join(',')} className="rx-st__sr" onChange={(e) => onLogoFile(e.target.files?.[0])} disabled={logo.isPending} aria-label="Upload company logo" />
                  </label>
                  <span className="rx-cpf__hint">Branding · PNG, JPG or WebP, under 2 MB</span>
                  {logoError && <p className="rx-formfield__err">{logoError}</p>}
                </div>
              )}
            </Card>

            <Card className="rx-cpf__details" title="Organization details" hint="Your organization’s current details">
              <dl className="rx-cpf__facts">
                <Fact label="Status">{profile.state ? <Badge tone={STATE_TONE[profile.state] ?? 'draft'}>{statusLabel(profile.state)}</Badge> : null}</Fact>
                <Fact label="Workspace">{profile.slug}</Fact>
                <Fact label="Country">{profile.countryCode}</Fact>
                <Fact label="Registered state">{profile.stateCode}</Fact>
                <Fact label="Time zone">{timeZoneLabel(profile.timezone)}</Fact>
                <Fact label="Locale">{profile.locale}</Fact>
                <Fact label="Operating states">{(profile.serviceStates ?? []).length ? profile.serviceStates.join(', ') : null}</Fact>
              </dl>
            </Card>

            <Card className="rx-cpf__support" title="Support" hint={`Help with ${PLATFORM_BRAND.productName}`}>
              <dl className="rx-cpf__facts">
                <Fact label="Platform provider">{PLATFORM_BRAND.providerName}</Fact>
                <Fact label="Support"><a className="rx-link" href={`mailto:${PLATFORM_BRAND.supportEmail}`}>{PLATFORM_BRAND.supportEmail}</a></Fact>
              </dl>
              <p className="rx-cpf__support-text">
                Need help? Contact {PLATFORM_BRAND.productName} at{' '}
                <a className="rx-link" href={`mailto:${PLATFORM_BRAND.supportEmail}`}>{PLATFORM_BRAND.supportEmail}</a>.
                {' '}Platform provided by {PLATFORM_BRAND.providerName}.
              </p>
            </Card>
          </aside>
        </div>
        </>
      )}
    </div>
  );
}

function Section({ icon: IconCmp, tone, id, title, description, children }) {
  return (
    <section className={`rx-sf__section rx-sf__section--${tone}`} aria-labelledby={id}>
      <div className="rx-sf__section-head">
        <span className="rx-sf__step" aria-hidden="true"><IconCmp size={16} /></span>
        <div>
          <h2 className="rx-sf__section-title" id={id}>{title}</h2>
          {description && <p className="rx-sf__section-desc">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function ReadOnlyField({ id, label, value, hint }) {
  return (
    <div>
      <Field label={label} htmlFor={id} hint={hint}>
        <div className="rx-input rx-cpf__locked" aria-readonly="true">
          <input id={id} value={value ?? ''} placeholder="Not set" readOnly disabled />
        </div>
      </Field>
    </div>
  );
}

function Fact({ label, children }) {
  const empty = children == null || children === '';
  return (
    <div className="rx-cpf__fact">
      <dt>{label}</dt>
      <dd className={empty ? 'is-empty' : undefined}>{empty ? 'Not set' : children}</dd>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="rx-sf__layout" aria-busy="true" aria-label="Loading company profile">
      <div className="rx-sf__main">{[0, 1, 2].map((i) => <div key={i} className="rx-skel" style={{ height: 220, borderRadius: 16 }} />)}</div>
      <div className="rx-skel" style={{ height: 320, borderRadius: 16 }} />
    </div>
  );
}

function ChangePasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');

  const mut = useMutation({
    mutationFn: () => changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => { toast.push('Password changed.'); setCurrent(''); setNext(''); setConfirm(''); setErr(''); },
    onError: (e) => {
      const fe = e?.response?.data?.error?.details?.fieldErrors;
      setErr(fe?.currentPassword?.[0] ? 'Current password is incorrect.' : (e?.response?.data?.error?.message ?? 'Could not change your password.'));
    },
  });

  function onSubmit(e) {
    e.preventDefault();
    setErr('');
    if (next.length < 10) { setErr('New password must be at least 10 characters.'); return; }
    if (next !== confirm) { setErr('The new passwords do not match.'); return; }
    mut.mutate();
  }

  return (
    <Section icon={Icon.Shield} tone="teal" id="cp-security" title="Account security" description="Change the password for your company account.">
      <form onSubmit={onSubmit} noValidate aria-label="Change password">
        <div className="rx-sf__grid">
          <div className="rx-cpf__full">
            <Field label="Current password" htmlFor="cp-current">
              <TextInput id="cp-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
          </div>
          <Field label="New password" htmlFor="cp-new" hint="At least 10 characters.">
            <TextInput id="cp-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm new password" htmlFor="cp-confirm">
            <TextInput id="cp-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </div>
        {err ? <p className="rx-formfield__err" role="alert">{err}</p> : null}
        <div className="rx-cpf__security-actions"><Button type="submit" variant="ghost" icon={Icon.Shield} loading={mut.isPending}>{mut.isPending ? 'Saving…' : 'Change password'}</Button></div>
      </form>
    </Section>
  );
}

export default CompanyProfileRedesign;
