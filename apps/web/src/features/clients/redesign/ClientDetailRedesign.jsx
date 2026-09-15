import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { getClient, transitionIntakeStatus, updateClient } from '@/api/client';
import { Card, Badge, Button, Icon, Tabs, ErrorState, TextInput } from '@/ui';
import { useToast } from '@/components';
import { usePermissions } from '@/auth/permissions';
import { InsurancePanelRedesign } from './InsurancePanelRedesign.jsx';
import { GuardianPanelRedesign } from './GuardianPanelRedesign.jsx';
import { AssignmentPanel } from './AssignmentPanel.jsx';
import { MedicalPanel } from './MedicalPanel.jsx';
import { AuthorizationsPanel } from './AuthorizationsPanel.jsx';
import { ChildAlertsCard } from './ProgressPanel.jsx';
import { ParentEmailEditor } from './ParentEmailEditor.jsx';
import { formatFullName, formatDate, formatPersonName, formatStatusLabel } from '@/lib/format';

/**
 * CLIENT PROFILE — Company Admin.
 *
 * One read (GET /v1/clients/:id → client, guardians, care team, authorizations)
 * feeds the hero and overview; each tab reuses its existing panel and API. The
 * server derives Account status; the referral stage, intake pipeline and FBA/ABA
 * workflow states are shown as separate, real statuses. Progress, Sessions and
 * Plans are intentionally not sections of the Company client profile — they live
 * in Scheduling, the Treatment Plan page and the BCBA/RBT client views.
 */

// Intake pipeline (mirrors backend INTAKE_WORKFLOW_TRANSITIONS — the server is
// authoritative; the UI only offers transitions it knows are valid).
const INTAKE_STEPS = ['NOT_SENT', 'SENT', 'HAND_DELIVERED', 'RECEIVED', 'MISSING_DOCUMENTS', 'COMPLETE'];
const INTAKE_NEXT = { NOT_SENT: ['SENT'], SENT: ['HAND_DELIVERED', 'RECEIVED', 'MISSING_DOCUMENTS'], HAND_DELIVERED: ['RECEIVED', 'MISSING_DOCUMENTS'], RECEIVED: ['MISSING_DOCUMENTS', 'COMPLETE'], MISSING_DOCUMENTS: ['RECEIVED', 'COMPLETE'], COMPLETE: ['MISSING_DOCUMENTS'] };

const TABS = [
  { id: 'overview', label: 'Overview', icon: Icon.Grid },
  { id: 'guardian', label: 'Parent / Guardian', icon: Icon.Users },
  { id: 'careteam', label: 'Care team', icon: Icon.User },
  { id: 'insurance', label: 'Insurance', icon: Icon.Shield },
  { id: 'authorizations', label: 'Authorizations', icon: Icon.CheckCircle },
  { id: 'medical', label: 'Medical', icon: Icon.Clipboard },
];

const ACCOUNT_TONE = { ACTIVE: 'approved', HOLD: 'pending', DISCHARGED: 'draft' };
const INTAKE_TONE = { COMPLETE: 'approved', MISSING_DOCUMENTS: 'denied', NOT_SENT: 'draft' };

function initials(a = '', b = '') { return ((a[0] || '') + (b[0] || '')).toUpperCase() || '—'; }

/** Friendly label for a guardian relationship enum — never show the raw code. */
const RELATIONSHIP_LABEL = { PARENT: 'Parent', LEGAL_GUARDIAN: 'Legal guardian', FOSTER_PARENT: 'Foster parent', GRANDPARENT: 'Grandparent', RELATIVE: 'Relative', CAREGIVER: 'Caregiver', OTHER: 'Other' };
function relationshipLabel(rel) {
  if (!rel) return 'Parent';
  return RELATIONSHIP_LABEL[rel] || formatStatusLabel(rel);
}

/** Care-team names arrive as "Last, First"; show "First Last". */
const staffDisplayName = (name) => {
  if (!name) return null;
  const [last, first] = String(name).split(',').map((p) => p.trim());
  return formatPersonName(first ? `${first} ${last}` : last);
};

/** The latest non-archived FBA / ABA authorization status (NOT_SENT when none). */
const authStatusOf = (auths, type) => (auths ?? []).filter((a) => a.serviceType === type).at(-1)?.status ?? 'NOT_SENT';

export function ClientDetailRedesign() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const { permissions } = usePermissions();
  const canUpdate = permissions.includes('clients.update');
  const [tab, setTab] = useState('overview');
  const [searchParams, setSearchParams] = useSearchParams();
  // ?compose=<templateId> (Email Templates → Use Template) opens the composer with it.
  const [composeTemplateId] = useState(() => searchParams.get('compose'));
  const [emailOpen, setEmailOpen] = useState(() => Boolean(searchParams.get('compose')));
  const client = useQuery({ queryKey: ['client', clientId], queryFn: () => getClient(clientId) });
  useEffect(() => {
    if (searchParams.get('compose')) { const next = new URLSearchParams(searchParams); next.delete('compose'); setSearchParams(next, { replace: true }); }
  }, []); // eslint-disable-line

  if (client.isLoading) return <ProfileSkeleton />;
  if (client.isError) {
    const notFound = [403, 404].includes(client.error?.response?.status);
    return (
      <div className="rx-cd">
        <Link to="/clients" className="rx-sp__back"><Icon.Return size={15} /> Back to Clients</Link>
        {notFound ? (
          <Card className="rx-cd__notfound">
            <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Child size={22} /></span>
            <h1 className="rx-cd__notfound-title">Client not found</h1>
            <p className="rx-st__empty-body">This client doesn’t exist or isn’t available to you.</p>
            <Link className="rx-btn rx-btn--primary" to="/clients">Back to Clients</Link>
          </Card>
        ) : <Card><ErrorState title="We couldn’t load this client" onRetry={() => client.refetch()} /></Card>}
      </div>
    );
  }
  // getClient returns { client, guardians, contacts, intake, careTeam } — read the
  // nested client for identity fields. Stay defensive if the shape is flattened.
  const detail = client.data ?? {};
  const c = detail.client ?? detail;
  const guardians = detail.guardians ?? c.guardians ?? [];
  const careTeam = (detail.careTeam ?? []).filter((m) => (m.status ?? 'ACTIVE') === 'ACTIVE');
  const auths = detail.serviceAuthorizations ?? [];
  const name = formatFullName({ firstName: c.firstName, middleName: c.middleName, lastName: c.lastName }) || 'Client';
  const account = c.accountStatus ?? 'HOLD';
  const intake = c.intakeWorkflowStatus || 'NOT_SENT';
  const bcba = careTeam.find((m) => m.role === 'BCBA');
  const rbt = careTeam.find((m) => m.role === 'RBT');

  return (
    <div className="rx-cd">
      <Link to="/clients" className="rx-sp__back"><Icon.Return size={15} /> Back to Clients</Link>

      <header className={`rx-cd__hero rx-cd__hero--${account.toLowerCase()}`}>
        <div className="rx-cd__hero-main">
          <div className="rx-cd__avatar" aria-hidden="true">{initials(c.firstName, c.lastName)}</div>
          <div className="rx-cd__identity">
            <h1 className="rx-cd__name">{name}</h1>
            <div className="rx-cd__ids">
              {c.clientNumber && <span>Client #{c.clientNumber}</span>}
              {c.dateOfBirth && <span>Born {formatDate(c.dateOfBirth)}</span>}
            </div>
            <div className="rx-cd__badges">
              <span className="rx-cd__badge-group"><span className="rx-cd__badge-k">Account</span><Badge tone={ACCOUNT_TONE[account] ?? 'draft'}>{formatStatusLabel(account)}</Badge></span>
              <span className="rx-cd__badge-group"><span className="rx-cd__badge-k">Stage</span><Badge tone="info" dot={false}>{formatStatusLabel(c.status) || 'Not provided'}</Badge></span>
              <span className="rx-cd__badge-group"><span className="rx-cd__badge-k">Intake</span><Badge tone={INTAKE_TONE[intake] ?? 'info'}>{formatStatusLabel(intake)}</Badge></span>
            </div>
          </div>
          <div className="rx-cd__actions">
            {canUpdate && <Button icon={Icon.Cog} onClick={() => navigate(`/clients/${clientId}/edit`)}>Edit Client</Button>}
            {canUpdate && <Button variant="ghost" icon={Icon.Doc} onClick={() => setEmailOpen(true)}>Send email</Button>}
            <Button variant="ghost" icon={Icon.Calendar} onClick={() => navigate('/scheduling')}>Schedule</Button>
          </div>
        </div>
        <dl className="rx-cd__facts">
          <Fact icon={Icon.User} tone="teal" label="BCBA" value={bcba ? staffDisplayName(bcba.staffName) : null} empty="Not assigned" />
          <Fact icon={Icon.User} tone="blue" label="RBT" value={rbt ? staffDisplayName(rbt.staffName) : null} empty="Not assigned" />
          <Fact icon={Icon.Shield} tone="violet" label="FBA / ABA" value={`${formatStatusLabel(authStatusOf(auths, 'FBA'))} · ${formatStatusLabel(authStatusOf(auths, 'ABA'))}`} />
          <Fact icon={Icon.Clock} tone="amber" label="Approved hours" value={c.approvedWeeklyHours != null ? `${c.approvedWeeklyHours} hrs/week` : null} empty="Not set" />
        </dl>
      </header>

      <ChildAlertsCard clientId={clientId} onNavigate={setTab} />
      {emailOpen && canUpdate && <ParentEmailEditor clientId={clientId} initialTemplateId={composeTemplateId} onClose={() => setEmailOpen(false)} />}

      <nav className="rx-cd__tabs" aria-label="Client sections"><Tabs tabs={TABS} value={tab} onChange={setTab} /></nav>
      <div className="rx-cd__panel">
        {tab === 'overview' && <OverviewTab c={c} guardians={guardians} onOpenGuardians={() => setTab('guardian')} />}
        {tab === 'medical' && <MedicalPanel clientId={clientId} />}
        {tab === 'guardian' && <GuardianPanelRedesign clientId={clientId} />}
        {tab === 'careteam' && <AssignmentPanel clientId={clientId} />}
        {tab === 'insurance' && <InsurancePanelRedesign clientId={clientId} />}
        {tab === 'authorizations' && <AuthorizationsPanel clientId={clientId} />}
      </div>
    </div>
  );
}

function Fact({ icon: IconCmp, tone, label, value, empty = 'Not provided' }) {
  return (
    <div className={`rx-cd__fact rx-cd__fact--${tone}`}>
      <span className="rx-cd__fact-icon" aria-hidden="true"><IconCmp size={16} /></span>
      <div className="rx-cd__fact-text">
        <dt>{label}</dt>
        <dd className={value ? undefined : 'is-empty'}>{value ?? empty}</dd>
      </div>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="rx-cd__row">
      <dt>{label}</dt>
      <dd>{value ?? '—'}</dd>
    </div>
  );
}

/**
 * Approved Weekly Hours — inline view/edit against the canonical
 * `approvedWeeklyHours` field (0–168). Persists via the existing PATCH
 * /clients/:id (optimistic-concurrency guarded by the client version), then
 * invalidates the client query so the value — and the scheduling capacity that
 * reads the same field — stay in sync. Never renders undefined/null/NaN.
 */
function ApprovedHoursRow({ c, clientId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');

  const save = useMutation({
    mutationFn: (hours) => updateClient(clientId, { approvedWeeklyHours: hours }, c.version),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['client', clientId] }); qc.invalidateQueries({ queryKey: ['clients'] }); setEditing(false); toast.push('Approved weekly hours saved.'); },
    onError: (e) => setErr(e?.response?.data?.error?.message ?? 'Could not save. Please try again.'),
  });

  function begin() { setValue(c.approvedWeeklyHours == null ? '' : String(c.approvedWeeklyHours)); setErr(''); setEditing(true); }
  function cancel() { setEditing(false); setErr(''); }
  function submit() {
    const trimmed = value.trim();
    if (trimmed === '') { setErr('Enter a number between 0 and 168.'); return; }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n > 168) { setErr('Approved hours must be between 0 and 168.'); return; }
    setErr('');
    save.mutate(n);
  }

  if (editing) {
    return (
      <div className="rx-cd__row rx-cd__row--edit">
        <dt>Approved weekly hours</dt>
        <dd>
          <div className="rx-cd__inline-edit">
            <div style={{ width: 120 }}>
              <TextInput type="number" min="0" max="168" step="0.5" value={value} autoFocus aria-label="Approved weekly hours"
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') cancel(); }} />
            </div>
            <span className="rx-cd__muted">hrs / week (0–168)</span>
            <Button size="sm" icon={Icon.Check} loading={save.isPending} onClick={submit}>Save</Button>
            <Button size="sm" variant="ghost" onClick={cancel} disabled={save.isPending}>Cancel</Button>
          </div>
          {err && <p className="rx-formfield__err" role="alert" style={{ marginTop: 6 }}>{err}</p>}
        </dd>
      </div>
    );
  }

  const isSet = c.approvedWeeklyHours != null;
  return (
    <div className="rx-cd__row">
      <dt>Approved weekly hours</dt>
      <dd className="rx-cd__row-action">
        <span className={isSet ? undefined : 'rx-cd__muted'}>{isSet ? `${c.approvedWeeklyHours} hrs/week` : 'Not set'}</span>
        <Button size="sm" variant="ghost" icon={isSet ? Icon.Cog : Icon.Plus} onClick={begin}>{isSet ? 'Edit' : 'Add'}</Button>
      </dd>
    </div>
  );
}

function OverviewTab({ c, guardians = [], onOpenGuardians }) {
  const { clientId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const current = c.intakeWorkflowStatus || 'NOT_SENT';
  const nexts = INTAKE_NEXT[current] || [];
  const currentIndex = INTAKE_STEPS.indexOf(current);
  const transition = useMutation({
    mutationFn: (target) => transitionIntakeStatus(clientId, target, c.version),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['client', clientId] }); qc.invalidateQueries({ queryKey: ['clients'] }); toast.push('Intake status updated.'); },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'That intake change isn’t allowed right now.', 'negative'),
  });
  const fullName = formatFullName({ firstName: c.firstName, middleName: c.middleName, lastName: c.lastName }) || 'Not provided';
  const addr = c.address ?? {};
  const hasAddress = Boolean(addr.line1 || addr.line2 || addr.city || addr.state || addr.postalCode);

  return (
    <div className="rx-cd__grid">
      <Card className="rx-cd__section rx-cd__section--violet" title="Client Information">
        <dl className="rx-cd__rows">
          <InfoRow label="Full name" value={fullName} />
          <InfoRow label="Client number" value={c.clientNumber || 'Not provided'} />
          <InfoRow label="Date of birth" value={c.dateOfBirth ? (formatDate(c.dateOfBirth) || 'Not provided') : 'Not provided'} />
          <InfoRow label="Account status" value={<Badge tone={ACCOUNT_TONE[c.accountStatus] ?? 'draft'}>{formatStatusLabel(c.accountStatus ?? 'HOLD')}</Badge>} />
          <InfoRow label="Referral stage" value={formatStatusLabel(c.status) || 'Not provided'} />
          <ApprovedHoursRow c={c} clientId={clientId} />
        </dl>
      </Card>

      <Card className="rx-cd__section rx-cd__section--teal" title="Intake pipeline" hint={`Current: ${formatStatusLabel(current)}`}>
        <ol className="rx-cd__pipeline" aria-label="Intake pipeline">
          {INTAKE_STEPS.map((step, i) => {
            const state = step === current ? 'current' : i < currentIndex ? 'done' : 'todo';
            return (
              <li key={step} className={`rx-cd__stage rx-cd__stage--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="rx-cd__stage-dot" aria-hidden="true">{state === 'done' ? <Icon.Check size={12} /> : i + 1}</span>
                <span className="rx-cd__stage-label">{formatStatusLabel(step)}</span>
              </li>
            );
          })}
        </ol>
        {nexts.length > 0 ? (
          <div className="rx-cd__pipeline-actions">
            {nexts.map((t) => (
              <Button key={t} variant="subtle" loading={transition.isPending} onClick={() => transition.mutate(t)}>
                Mark {formatStatusLabel(t)}
              </Button>
            ))}
          </div>
        ) : <p className="rx-card__hint" style={{ marginTop: 12 }}>Intake complete.</p>}
      </Card>

      <Card className="rx-cd__section rx-cd__section--blue" title="Parent / Guardian"
        action={<button type="button" className="rx-cd__link" onClick={onOpenGuardians}>Manage <Icon.Arrow size={14} /></button>}>
        {guardians.length > 0 ? (
          <ul className="rx-cd__people">
            {guardians.map((g, i) => (
              <li key={g.id || i} className="rx-cd__person">
                <span className="rx-cd__person-avatar" aria-hidden="true">{initials(g.firstName, g.lastName)}</span>
                <div className="rx-cd__person-main">
                  <div className="rx-cd__person-name">
                    {formatFullName({ firstName: g.firstName, lastName: g.lastName }) || 'Not provided'}
                    {g.isPrimary && <span className="rx-cd__primary">Primary</span>}
                  </div>
                  <div className="rx-cd__person-meta">{relationshipLabel(g.relationship)}</div>
                  <div className="rx-cd__person-contact">
                    <span className={g.phone ? undefined : 'rx-cd__muted'}>{g.phone || 'No mobile'}</span>
                    <span className={g.email ? undefined : 'rx-cd__muted'}>{g.email || 'No email'}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rx-cd__empty">
            <span className="rx-cd__empty-icon" aria-hidden="true"><Icon.Users size={18} /></span>
            <div><div className="rx-cd__empty-title">No parent on file</div><p>Add a parent (name, mobile, email) to activate this client.</p></div>
          </div>
        )}
      </Card>

      <Card className="rx-cd__section rx-cd__section--amber" title="Address">
        {hasAddress ? (
          <address className="rx-cd__address">
            <span>{addr.line1 || 'Not provided'}</span>
            {addr.line2 ? <span>{addr.line2}</span> : null}
            <span>{[addr.city, addr.state].filter(Boolean).join(', ') || 'City and state not provided'} {addr.postalCode || ''}</span>
          </address>
        ) : (
          <div className="rx-cd__empty">
            <span className="rx-cd__empty-icon" aria-hidden="true"><Icon.Building size={18} /></span>
            <div><div className="rx-cd__empty-title">No address on file</div><p>Add an address from Edit Client.</p></div>
          </div>
        )}
      </Card>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="rx-cd" aria-busy="true" aria-label="Loading client">
      <div className="rx-skel" style={{ height: 14, width: 120 }} />
      <div className="rx-skel" style={{ height: 180, borderRadius: 20 }} />
      <div className="rx-skel" style={{ height: 44 }} />
      <div className="rx-cd__grid">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel" style={{ height: 220 }} />)}</div>
    </div>
  );
}

export default ClientDetailRedesign;
