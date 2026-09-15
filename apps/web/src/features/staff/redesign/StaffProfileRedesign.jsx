import { useEffect, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStaff, updateStaff, adminResetMemberPassword, resendStaffLoginEmail, listSessions } from '@/api/client';
import { usePermissions } from '@/auth/permissions';
import { useOrgTimezone } from '@/auth/store';
import { Badge, Button, Card, Confirm, ErrorState, Icon } from '@/ui';
import { useToast } from '@/components';
import { formatDate, formatDateTime, formatFullName, formatMoney, formatPersonName, sessionStatusText } from '@/lib/format';
import { StaffEditModal } from '../StaffEditModal.jsx';

/**
 * STAFF PROFILE — Company Admin view of one staff member.
 *
 * Data (no fabricated values; a section renders only when its data exists):
 *   GET /v1/staff/:staffId      profile, login metadata, role, current pay rate
 *                               (only when this viewer may see pay) and active
 *                               caseload (only for tenant-wide client readers).
 *                               Scoped server-side by staff.read.
 *   GET /v1/sessions?staffProfileId=…&limit=5   recent sessions, for viewers
 *                               holding sessions.read (server-scoped).
 * Writes go through the existing PATCH /v1/staff/:staffId (If-Match version),
 * the admin reset-link and resend-login endpoints — all gated by staff.manage
 * on the server.
 */

const ROLE_LABELS = { bcba: 'BCBA', rbt: 'RBT', manager: 'Manager', owner: 'Owner', org_admin: 'Admin' };
const ROLE_TONE = { bcba: 'bcba', rbt: 'rbt' };
const ACCOUNT_STATUS_LABELS = { ACTIVE: 'Active', SUSPENDED: 'Suspended', DISABLED: 'Disabled', INVITED: 'Invited', PENDING: 'Pending', REMOVED: 'Removed' };
const CLIENT_STATUS_LABEL = { REFERRED: 'Referred', INTAKE: 'Intake', ACTIVE: 'Active', ON_HOLD: 'On hold', DISCHARGED: 'Discharged' };

export const roleLabel = (key) => ROLE_LABELS[key] ?? (key ? formatPersonName(String(key).replace(/_/g, ' ')) : null);
const initials = (s) => (`${s.firstName?.[0] ?? ''}${s.lastName?.[0] ?? ''}`.toUpperCase() || '—');
const hasField = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

/** "1h 30m" from persisted worked minutes. */
function workedText(minutes) {
  if (minutes == null) return null;
  const m = Math.max(0, Math.round(Number(minutes)));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Whole months/years since a 'YYYY-MM-DD' start date, e.g. "1 yr 3 mo". Null when not started. */
export function tenureText(startDate, now = new Date()) {
  if (!startDate) return null;
  const [y, m, d] = String(startDate).slice(0, 10).split('-').map(Number);
  let months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  if (now.getDate() < d) months -= 1;
  if (months < 0) return null;
  if (months === 0) return 'Less than a month';
  const yrs = Math.floor(months / 12);
  const mos = months % 12;
  return [yrs ? `${yrs} yr${yrs === 1 ? '' : 's'}` : null, mos ? `${mos} mo` : null].filter(Boolean).join(' ');
}

export function StaffProfileRedesign() {
  const { staffId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { permissions } = usePermissions();
  const canManage = permissions.includes('staff.manage');
  const canReadSessions = permissions.includes('sessions.read');

  // App-wide retry policy applies (no retry on 4xx), so not-found renders at once.
  const query = useQuery({ queryKey: ['staff', staffId], queryFn: () => getStaff(staffId) });
  const [editing, setEditing] = useState(false);

  // /staff/:id/edit (and ?edit=1) open the editor on the profile.
  useEffect(() => {
    if (searchParams.get('edit') === '1' && canManage && query.data) {
      setEditing(true);
      const next = new URLSearchParams(searchParams); next.delete('edit');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, canManage, query.data, setSearchParams]);

  return (
    <div className="rx-sp">
      <Link to="/staff" className="rx-sp__back"><Icon.Return size={15} /> Back to Staff</Link>
      {query.isLoading ? <ProfileSkeleton /> : query.isError ? (
        [400, 403, 404].includes(query.error?.response?.status) ? <NotFound /> : (
          <Card><ErrorState title="We couldn’t load this staff member" body="Please try again in a moment." onRetry={() => query.refetch()} /></Card>
        )
      ) : (
        <Profile detail={query.data} staffId={staffId} canManage={canManage} canReadSessions={canReadSessions} onEdit={() => setEditing(true)} />
      )}
      {editing && query.data && (
        <StaffEditModal staff={query.data.staff} staffId={staffId} canManage={canManage} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

function Profile({ detail, staffId, canManage, canReadSessions, onEdit }) {
  const { staff, account, caseload } = detail;
  const timeZone = useOrgTimezone() || undefined;
  const roleKeys = staff.roleKeys ?? account?.roleKeys ?? [];
  const primaryRole = roleKeys.find((k) => ROLE_TONE[k]) ?? roleKeys[0] ?? null;
  const payVisible = hasField(staff, 'hourlyPayRate');
  const name = formatFullName(staff) || 'Staff member';

  return (
    <>
      <Hero staff={staff} account={account} name={name} roleKeys={roleKeys} primaryRole={primaryRole} staffId={staffId} canManage={canManage} onEdit={onEdit} />

      <section className="rx-sp__summary" aria-label="Profile summary">
        <SummaryCard tone="violet" icon={Icon.Shield} label="Role" value={roleKeys.length ? roleKeys.map(roleLabel).join(', ') : 'Not assigned'} hint={staff.title || null} />
        <SummaryCard tone={staff.status === 'ACTIVE' ? 'green' : 'slate'} icon={Icon.CheckCircle} label="Employment status" value={staff.status === 'ACTIVE' ? 'Active' : 'Inactive'}
          hint={staff.startDate ? `Since ${formatDate(staff.startDate)}` : null} />
        {payVisible && (
          <SummaryCard tone="amber" icon={Icon.Wallet} label="Hourly pay rate" value={staff.hourlyPayRate != null ? `${formatMoney(Math.round(Number(staff.hourlyPayRate) * 100))}/hr` : 'Not set'} hint="Current effective rate" />
        )}
        {caseload && (
          <SummaryCard tone="blue" icon={Icon.Child} label="Active clients" value={String(caseload.activeClientCount)} hint={caseload.activeClientCount === 0 ? 'No active assignments' : 'Current caseload'} />
        )}
        {!caseload && staff.startDate && tenureText(staff.startDate) && (
          <SummaryCard tone="blue" icon={Icon.Calendar} label="Tenure" value={tenureText(staff.startDate)} hint={`Started ${formatDate(staff.startDate)}`} />
        )}
      </section>

      <div className="rx-sp__cols">
        <Card className="rx-sp__section rx-sp__section--personal" title="Personal information">
          <dl className="rx-sp__facts">
            <Fact label="First name" value={staff.firstName ? formatPersonName(staff.firstName) : null} />
            <Fact label="Middle name" value={staff.middleName ? formatPersonName(staff.middleName) : null} />
            <Fact label="Last name" value={staff.lastName ? formatPersonName(staff.lastName) : null} />
            <Fact label="Email" value={account?.loginEmail ?? staff.loginEmail} href={(account?.loginEmail ?? staff.loginEmail) ? `mailto:${account?.loginEmail ?? staff.loginEmail}` : null} />
          </dl>
        </Card>

        <Card className="rx-sp__section rx-sp__section--professional" title="Professional information">
          <dl className="rx-sp__facts">
            <Fact label="Role" value={roleKeys.length ? roleKeys.map(roleLabel).join(', ') : null} />
            <Fact label="Title" value={staff.title} />
            <Fact label="Discipline" value={staff.discipline} />
            <Fact label="Employee ID" value={staff.employeeNumber} />
            <Fact label="Employment status" value={<StatusBadge status={staff.status} />} />
            <Fact label="Start date" value={staff.startDate ? formatDate(staff.startDate) : null} />
            {payVisible && <Fact label="Hourly pay rate" value={staff.hourlyPayRate != null ? `${formatMoney(Math.round(Number(staff.hourlyPayRate) * 100))}/hr` : null} />}
          </dl>
        </Card>
      </div>

      {account && (
        <Card className="rx-sp__section rx-sp__section--account" title="Account & sign-in" hint="Login details only — passwords are never shown">
          <dl className="rx-sp__facts rx-sp__facts--grid">
            <Fact label="Login email" value={account.loginEmail} />
            <Fact label="Account status" value={ACCOUNT_STATUS_LABELS[account.accountStatus] ?? account.accountStatus} />
            <Fact label="First login" value={account.firstLoginCompleted ? (account.firstLoginAt ? formatDateTime(account.firstLoginAt, timeZone) : 'Completed') : 'Not completed yet'} />
            <Fact label="Last login" value={account.lastLoginAt ? formatDateTime(account.lastLoginAt, timeZone) : null} empty="No sign-in yet" />
          </dl>
        </Card>
      )}

      <div className="rx-sp__cols">
        {caseload && <CaseloadCard caseload={caseload} />}
        {canReadSessions && <RecentSessionsCard staffId={staffId} wide={!caseload} timeZone={timeZone} />}
      </div>
    </>
  );
}

// --- hero ----------------------------------------------------------------------

function Hero({ staff, account, name, roleKeys, primaryRole, staffId, canManage, onEdit }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(null); // 'deactivate' | 'reactivate' | 'reset' | 'resend'
  const email = account?.loginEmail ?? staff.loginEmail ?? null;
  const active = staff.status === 'ACTIVE';

  const status = useMutation({
    mutationFn: (next) => updateStaff(staffId, { status: next }, staff.version),
    onSuccess: async (_d, next) => {
      setConfirm(null);
      await qc.invalidateQueries({ queryKey: ['staff'] });
      toast.push(next === 'ACTIVE' ? `${name} is active again.` : `${name} is now inactive.`);
    },
    onError: (e) => { setConfirm(null); toast.push(e?.response?.data?.error?.message ?? 'The status could not be changed.', 'negative'); },
  });
  const reset = useMutation({
    mutationFn: () => adminResetMemberPassword(staff.membershipId),
    onSuccess: () => { setConfirm(null); toast.push('A secure reset link has been sent.'); },
    onError: (e) => { setConfirm(null); toast.push(e?.response?.data?.error?.message ?? 'Could not send the reset link.', 'negative'); },
  });
  const resend = useMutation({
    mutationFn: () => resendStaffLoginEmail(staffId),
    onSuccess: async (res) => {
      setConfirm(null);
      toast.push(res?.emailQueued ? 'Login email resent.' : 'The login email could not be queued.', res?.emailQueued ? undefined : 'negative');
      await qc.invalidateQueries({ queryKey: ['staff', staffId] });
    },
    onError: (e) => { setConfirm(null); toast.push(e?.response?.data?.error?.message ?? 'Could not resend the login email.', 'negative'); },
  });

  const canResend = canManage && Boolean(staff.membershipId) && account?.firstLoginCompleted !== true;

  return (
    <header className={`rx-sp__hero rx-sp__hero--${ROLE_TONE[primaryRole] ?? 'default'}`}>
      <div className="rx-sp__hero-band" aria-hidden="true" />
      <div className="rx-sp__hero-body">
        <div className="rx-sp__avatar" aria-hidden="true">{initials(staff)}</div>
        <div className="rx-sp__identity">
          <h1 className="rx-sp__name">{name}</h1>
          <div className="rx-sp__chips">
            {roleKeys.map((k) => <span key={k} className={`rx-sp__role rx-sp__role--${ROLE_TONE[k] ?? 'default'}`}>{roleLabel(k)}</span>)}
            <StatusBadge status={staff.status} />
            {staff.title && <span className="rx-sp__title">{staff.title}</span>}
          </div>
          <ul className="rx-sp__meta" aria-label="Contact and identifiers">
            {email && <li><Icon.Doc size={15} aria-hidden="true" /><a href={`mailto:${email}`}>{email}</a></li>}
            {staff.employeeNumber && <li><Icon.Clipboard size={15} aria-hidden="true" />Employee ID {staff.employeeNumber}</li>}
            {staff.startDate && <li><Icon.Calendar size={15} aria-hidden="true" />Started {formatDate(staff.startDate)}</li>}
          </ul>
        </div>
        {canManage && (
          <div className="rx-sp__actions">
            <Button onClick={onEdit}>Edit profile</Button>
            {active
              ? <Button variant="ghost" onClick={() => setConfirm('deactivate')} loading={status.isPending}>Deactivate</Button>
              : <Button variant="ghost" onClick={() => setConfirm('reactivate')} loading={status.isPending}>Reactivate</Button>}
            {staff.membershipId && <Button variant="ghost" icon={Icon.Shield} onClick={() => setConfirm('reset')} loading={reset.isPending}>Reset password</Button>}
            {canResend && <Button variant="ghost" onClick={() => setConfirm('resend')} loading={resend.isPending}>Resend login email</Button>}
          </div>
        )}
      </div>

      <Confirm open={confirm === 'deactivate'} tone="danger" title={`Deactivate ${name}?`}
        message="Their status changes to Inactive. The profile, history and payroll records are kept, and you can reactivate them at any time."
        confirmLabel="Deactivate" busy={status.isPending} onConfirm={() => status.mutate('INACTIVE')} onCancel={() => setConfirm(null)} />
      <Confirm open={confirm === 'reactivate'} title={`Reactivate ${name}?`} message="Their status changes back to Active."
        confirmLabel="Reactivate" busy={status.isPending} onConfirm={() => status.mutate('ACTIVE')} onCancel={() => setConfirm(null)} />
      <Confirm open={confirm === 'reset'} title="Send a password reset link?"
        message="A secure link is emailed to the staff member. They choose their own password — you never see it."
        confirmLabel="Send reset link" busy={reset.isPending} onConfirm={() => reset.mutate()} onCancel={() => setConfirm(null)} />
      <Confirm open={confirm === 'resend'} title="Resend the login email?"
        message="They haven’t signed in yet. This sends a fresh temporary password and invalidates the previous one."
        confirmLabel="Resend" busy={resend.isPending} onConfirm={() => resend.mutate()} onCancel={() => setConfirm(null)} />
    </header>
  );
}

// --- sections --------------------------------------------------------------------

function CaseloadCard({ caseload }) {
  return (
    <Card className="rx-sp__section rx-sp__section--caseload" title="Assigned clients" hint="Active care-team assignments"
      action={<Badge tone="info">{caseload.activeClientCount}</Badge>}>
      {caseload.assignments.length === 0 ? (
        <p className="rx-sp__empty">No active client assignments.</p>
      ) : (
        <ul className="rx-sp__list" aria-label="Assigned clients">
          {caseload.assignments.map((a) => (
            <li key={a.assignmentId} className="rx-sp__item">
              <span className="rx-sp__item-avatar" aria-hidden="true">{(a.clientName ?? '?').split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}</span>
              <div className="rx-sp__item-main">
                <Link to={`/clients/${a.clientId}`} className="rx-sp__item-title">{a.clientName ? formatPersonName(a.clientName) : 'Client'}</Link>
                <div className="rx-sp__item-meta">
                  {[roleLabel(String(a.role).toLowerCase()), a.isPrimary ? 'Primary' : null, a.weeklyAssignedHours != null ? `${a.weeklyAssignedHours} hrs/week` : null, a.effectiveStartDate ? `Since ${formatDate(a.effectiveStartDate)}` : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              {a.clientStatus && <Badge status={a.clientStatus}>{CLIENT_STATUS_LABEL[a.clientStatus] ?? a.clientStatus}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentSessionsCard({ staffId, wide, timeZone }) {
  const params = { staffProfileId: staffId, limit: 5 };
  const query = useQuery({ queryKey: ['sessions', params], queryFn: () => listSessions(params), retry: false });
  const items = query.data?.items ?? [];
  return (
    <Card className={`rx-sp__section rx-sp__section--activity${wide ? ' rx-sp__span-all' : ''}`} title="Recent sessions" hint="Latest recorded work"
      action={<Link className="rx-sp__link" to="/sessions">View sessions <Icon.Arrow size={14} /></Link>}>
      {query.isLoading ? (
        <div className="rx-sp__skel-list">{[0, 1, 2].map((i) => <div key={i} className="rx-skel" style={{ height: 44 }} />)}</div>
      ) : query.isError ? (
        <p className="rx-sp__empty" role="alert">Recent sessions couldn’t be loaded. <button type="button" className="rx-sp__retry" onClick={() => query.refetch()}>Retry</button></p>
      ) : items.length === 0 ? (
        <p className="rx-sp__empty">No sessions recorded yet.</p>
      ) : (
        <ul className="rx-sp__list" aria-label="Recent sessions">
          {items.map((s) => (
            <li key={s.id} className="rx-sp__item">
              <span className="rx-sp__item-icon" aria-hidden="true"><Icon.Clock size={16} /></span>
              <div className="rx-sp__item-main">
                <Link to={`/sessions/${s.id}`} className="rx-sp__item-title">{s.childName ? formatPersonName(s.childName) : 'Session'}</Link>
                <div className="rx-sp__item-meta">
                  {[s.startedAt ? formatDateTime(s.startedAt, timeZone) : null, workedText(s.workedMinutes), s.source === 'MANUAL' ? 'Manual entry' : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <Badge status={s.status}>{sessionStatusText(s)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- shared --------------------------------------------------------------------------

function StatusBadge({ status }) {
  return <Badge tone={status === 'ACTIVE' ? 'approved' : 'draft'}>{status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge>;
}

function SummaryCard({ tone, icon: IconCmp, label, value, hint }) {
  return (
    <div className={`rx-sp__stat rx-sp__stat--${tone}`}>
      <span className="rx-sp__stat-icon" aria-hidden="true"><IconCmp size={18} /></span>
      <div className="rx-sp__stat-body">
        <div className="rx-sp__stat-label">{label}</div>
        <div className="rx-sp__stat-value">{value}</div>
        {hint && <div className="rx-sp__stat-hint">{hint}</div>}
      </div>
    </div>
  );
}

function Fact({ label, value, href, empty = 'Not provided' }) {
  const missing = value == null || value === '';
  return (
    <div className="rx-sp__fact">
      <dt>{label}</dt>
      <dd className={missing ? 'rx-sp__fact--empty' : undefined}>
        {missing ? empty : href ? <a href={href}>{value}</a> : value}
      </dd>
    </div>
  );
}

function NotFound() {
  return (
    <Card className="rx-sp__notfound">
      <div className="rx-sp__notfound-icon" aria-hidden="true"><Icon.Users size={26} /></div>
      <h1 className="rx-sp__notfound-title">Staff member not found</h1>
      <p className="rx-sp__empty">This staff member doesn’t exist or isn’t available to you.</p>
      <Link className="rx-btn rx-btn--primary" to="/staff">Back to Staff</Link>
    </Card>
  );
}

function ProfileSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading staff profile">
      <div className="rx-sp__hero rx-sp__hero--default"><div className="rx-sp__hero-band" /><div className="rx-sp__hero-body">
        <div className="rx-skel rx-sp__avatar" /><div style={{ flex: 1 }}><div className="rx-skel" style={{ height: 26, width: '40%' }} /><div className="rx-skel" style={{ height: 14, width: '60%', marginTop: 12 }} /></div>
      </div></div>
      <div className="rx-sp__summary">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel" style={{ height: 92 }} />)}</div>
      <div className="rx-sp__cols">{[0, 1].map((i) => <div key={i} className="rx-skel" style={{ height: 240 }} />)}</div>
    </div>
  );
}

/** /staff/:staffId/edit → the profile with its editor open. */
export function StaffEditRedirect() {
  const { staffId } = useParams();
  return <Navigate to={`/staff/${encodeURIComponent(staffId)}?edit=1`} replace />;
}

export default StaffProfileRedesign;
