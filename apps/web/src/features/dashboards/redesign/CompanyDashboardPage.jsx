import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getCompanyDashboard } from '@/api/client';
import { Badge, Card, Icon, Donut, ErrorState, Modal } from '@/ui';
import { useOrgTimezone } from '@/auth/store';
import { useBusinessDate } from '@/lib/useBusinessDate';
import { formatDate, formatFirstName, formatPersonName, formatTime, statusLabel } from '@/lib/format';
import { AppointmentNoteReadOnly } from '@/features/scheduling/redesign/AppointmentNotesOverview.jsx';
import { SessionRow } from '@/features/sessions/redesign/CompanySessionsPage.jsx';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * COMPANY ADMIN DASHBOARD.
 *
 * One read — GET /v1/dashboards/company — returns every section already
 * aggregated, tenant-scoped and rule-checked on the server (client account
 * status, staff status and clinical roles, BCBA / RBT sessions by role,
 * attention rules, authorization expiry, the organization's business date,
 * derived session status, persisted SessionTimeRecord times). This page only
 * presents it: no counting, filtering or date logic happens here, and nothing
 * is shown that the API did not return. The only arithmetic is a display
 * percentage of two server counts.
 *
 * Visual language is the Client / Staff / Sessions pages' own: the same page
 * header, summary cards, cards, list tables and session rows.
 */

const CLIENT_COLORS = { ACTIVE: 'var(--color-state-approved)', HOLD: 'var(--color-state-pending)', DISCHARGED: 'var(--color-state-draft)' };
const STAFF_COLORS = { ACTIVE: 'var(--color-state-approved)', INACTIVE: 'var(--color-state-draft)' };
const SESSION_TONE = { COMPLETED: 'approved', IN_PROGRESS: 'info', STOPPED: 'pending', SCHEDULED: 'draft', CANCELLED: 'denied', NO_SHOW: 'denied' };
const CLIENT_STATUS_LABEL = { REFERRED: 'Referred', INTAKE: 'Intake', ACTIVE: 'Active', ON_HOLD: 'On hold', DISCHARGED: 'Discharged', ARCHIVED: 'Archived' };
const AUTH_STATUS_LABEL = { NOT_SENT: 'Not sent', SENT: 'Sent', APPROVED: 'Approved', DENIED: 'Denied' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const name = (value, fallback = '—') => (value ? formatPersonName(value) : fallback);
const initials = (value) => String(value || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '·';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "1h 30m" from persisted worked minutes. */
export function workedText(minutes) {
  if (minutes == null) return null;
  const m = Math.max(0, Math.round(Number(minutes)));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** The Today row's time, exactly as the server classified it. */
export function todayTimeText(row, timeZone) {
  if (row.timeKind === 'ALL_DAY') return 'All day';
  const start = row.startAt ? formatTime(row.startAt, timeZone) : null;
  if (!start) return '—';
  if (!row.endAt) return row.timeKind === 'ACTUAL' ? `Started ${start}` : start;
  return `${start} – ${formatTime(row.endAt, timeZone)}`;
}

/** "Monday, 09/14/2026" for a 'YYYY-MM-DD' business date (never shifted). */
function businessDateLabel(date) {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${formatDate(date)}`;
}

export function CompanyDashboardPage() {
  const timeZone = useOrgTimezone() || undefined;
  // Keyed on the org business date: the dashboard refetches when the day changes.
  const businessDate = useBusinessDate(timeZone);
  const query = useQuery({
    queryKey: ['dashboard', 'company', businessDate],
    queryFn: getCompanyDashboard,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });
  const data = query.data;

  return (
    <div className="rx-db">
      <header className="rx-st__head">
        <div className="rx-st__head-text">
          <h1 className="rx-st__title">Dashboard</h1>
          <p className="rx-st__subtitle">Clients, staff, sessions and today’s priorities across your organization.</p>
        </div>
        {data?.businessDate && (
          <span className="rx-db__date"><Icon.Calendar size={15} aria-hidden="true" />{businessDateLabel(data.businessDate)}</span>
        )}
      </header>

      {query.isLoading ? <DashboardSkeleton /> : query.isError ? (
        <Card pad={false}><ErrorState title="We couldn’t load the dashboard" body="Please try again in a moment." onRetry={() => query.refetch()} /></Card>
      ) : (
        <DashboardContent data={data} timeZone={timeZone ?? data?.timeZone} />
      )}
    </div>
  );
}

function DashboardContent({ data, timeZone }) {
  const { appointmentNotes } = data;
  return (
    <>
      <SummaryCards data={data} />
      <div className="rx-db__grid rx-db__grid--3">
        <ClientOverview clients={data.clients} />
        <StaffOverview staff={data.staff} />
        <RoleSessionsOverview byRole={data.sessionsByRole} today={data.today} />
      </div>
      <TodaySessions today={data.today} timeZone={timeZone} businessDate={data.businessDate} />
      <div className={`rx-db__grid rx-db__grid--lists ${appointmentNotes ? 'rx-db__grid--3' : 'rx-db__grid--2'}`}>
        <AttentionCard attention={data.attention} />
        <ExpiringAuthorizationsCard expiring={data.expiringAuthorizations} />
        {appointmentNotes && <AppointmentNotesCard notes={appointmentNotes} businessDate={data.businessDate} timeZone={timeZone} />}
      </div>
      <LatestSessions sessions={data.latestSessions} timeZone={timeZone} />
    </>
  );
}

// --- Shared building blocks (Client / Staff page patterns) -------------------

function Panel({ id, title, hint, action, flush = false, className = '', children }) {
  return (
    <section id={id} className={`rx-card ${flush ? '' : 'rx-card--pad '}rx-db__panel ${className}`} aria-labelledby={`${id}-title`}>
      <header className={`rx-db__panel-head${flush ? ' rx-db__panel-head--flush' : ''}`}>
        <div className="rx-db__panel-heading">
          <h2 id={`${id}-title`} className="rx-card__title">{title}</h2>
          {hint && <p className="rx-card__hint">{hint}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

const ViewLink = ({ to, children }) => <Link className="rx-st__action rx-st__action--primary" to={to}>{children} <Icon.Arrow size={14} aria-hidden="true" /></Link>;
const CountBadge = ({ value, tone }) => (value > 0 ? <Badge tone={tone}>{value}</Badge> : null);

function EmptyBlock({ icon: IconCmp, title, body }) {
  return (
    <div className="rx-st__empty rx-db__empty">
      <span className="rx-st__empty-icon" aria-hidden="true"><IconCmp size={22} /></span>
      <div className="rx-st__empty-title">{title}</div>
      {body && <p className="rx-st__empty-body">{body}</p>}
    </div>
  );
}

function Stat({ tone, icon: IconCmp, label, value, hint, to, href }) {
  const body = (
    <>
      <span className="rx-cl__stat-icon" aria-hidden="true"><IconCmp size={18} /></span>
      <span className="rx-cl__stat-body">
        <span className="rx-cl__stat-label">{label}</span>
        <span className="rx-cl__stat-value">{value}</span>
        <span className="rx-cl__stat-hint">{hint}</span>
      </span>
    </>
  );
  const cls = `rx-cl__stat rx-cl__stat--${tone} rx-db__stat`;
  if (to) return <Link className={cls} to={to}>{body}</Link>;
  if (href) return <a className={cls} href={href}>{body}</a>;
  return <div className={cls}>{body}</div>;
}

function Breakdown({ label, rows }) {
  return (
    <dl className="rx-db__breakdown" aria-label={label}>
      {rows.map((r) => (
        <div key={r.key} className="rx-db__breakdown-row">
          <dt><i style={{ background: r.color }} aria-hidden="true" />{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// --- 1. Summary cards (server totals) -----------------------------------------

function SummaryCards({ data }) {
  const { clients, staff, today, attention, expiringAuthorizations } = data;
  return (
    <section className="rx-cl__summary" aria-label="Organization summary">
      <Stat tone="violet" icon={Icon.Child} label="Total clients" value={clients.total} to="/clients"
        hint={`${clients.active} active · ${clients.inactive} inactive`} />
      <Stat tone="green" icon={Icon.Users} label="Total staff" value={staff.total} to="/staff"
        hint={`${staff.active} active · ${staff.inactive} inactive`} />
      <Stat tone="blue" icon={Icon.Calendar} label="Today’s sessions" value={today.total} href="#dash-today"
        hint={`${today.byRole?.BCBA ?? 0} BCBA · ${today.byRole?.RBT ?? 0} RBT`} />
      <Stat tone="amber" icon={Icon.Bell} label="Needs attention" value={attention.total} href="#dash-attention"
        hint={`${plural(expiringAuthorizations.total, 'authorization')} expiring soon`} />
    </section>
  );
}

// --- 2. Client overview -------------------------------------------------------

function ClientOverview({ clients }) {
  const account = clients.byAccount ?? {};
  return (
    <Panel id="dash-clients" title="Client overview" hint="Account status, the same rule as the Clients page" action={<ViewLink to="/clients">View</ViewLink>}>
      {clients.total === 0 ? (
        <EmptyBlock icon={Icon.Child} title="No clients yet" body="Clients appear here once they are added." />
      ) : (
        <div className="rx-db__chart">
          <Donut
            data={{ ACTIVE: account.ACTIVE ?? clients.active, HOLD: account.HOLD ?? 0, DISCHARGED: account.DISCHARGED ?? 0 }}
            labels={{ ACTIVE: 'Active', HOLD: 'Hold', DISCHARGED: 'Discharged' }}
            colors={CLIENT_COLORS}
            size={132}
            thickness={16}
            centerValue={clients.total}
            centerLabel={clients.total === 1 ? 'client' : 'clients'}
            ariaLabel="Clients by account status"
            showPercent
          />
        </div>
      )}
    </Panel>
  );
}

// --- 3. Staff overview --------------------------------------------------------

function StaffOverview({ staff }) {
  return (
    <Panel id="dash-staff" title="Staff overview" hint="Staff status and active clinicians by role" action={<ViewLink to="/staff">View</ViewLink>}>
      {staff.total === 0 ? (
        <EmptyBlock icon={Icon.Users} title="No staff yet" body="Add BCBAs and RBTs to start building care teams." />
      ) : (
        <div className="rx-db__chart">
          <Donut
            data={{ ACTIVE: staff.active, INACTIVE: staff.inactive }}
            labels={{ ACTIVE: 'Active', INACTIVE: 'Inactive' }}
            colors={STAFF_COLORS}
            size={132}
            thickness={16}
            centerValue={staff.total}
            centerLabel="staff"
            ariaLabel="Staff by status"
            showPercent
          />
          <Breakdown label="Active clinicians by role" rows={[
            { key: 'BCBA', label: 'Active BCBAs', value: staff.bcba, color: PLATFORM_BRAND.colors.secondary },
            { key: 'RBT', label: 'Active RBTs', value: staff.rbt, color: PLATFORM_BRAND.colors.primary },
          ]} />
        </div>
      )}
    </Panel>
  );
}

// --- 4. BCBA / RBT sessions ---------------------------------------------------

function RoleSessionsOverview({ byRole, today }) {
  const period = byRole?.period;
  const hint = period ? `Month to date · ${formatDate(period.from)} – ${formatDate(period.to)}` : 'Month to date';
  const roles = [
    { key: 'BCBA', data: byRole?.BCBA, today: today.byRole?.BCBA ?? 0 },
    { key: 'RBT', data: byRole?.RBT, today: today.byRole?.RBT ?? 0 },
  ];
  return (
    <Panel id="dash-roles" title="BCBA and RBT sessions" hint={hint} action={<ViewLink to="/sessions/oversight">Insights</ViewLink>}>
      {!byRole ? (
        <EmptyBlock icon={Icon.Clipboard} title="Session breakdown unavailable" />
      ) : (
        <div className="rx-db__roles">
          {roles.map((r) => (
            <div key={r.key} className={`rx-db__role rx-db__role--${r.key.toLowerCase()}`} aria-label={`${r.key} sessions`}>
              <span className={`rx-st__role rx-st__role--${r.key.toLowerCase()}`}>{r.key}</span>
              <dl>
                <div><dt>Sessions</dt><dd>{r.data.sessions}</dd></div>
                <div><dt>Completed</dt><dd>{r.data.completed}</dd></div>
                <div><dt>Worked</dt><dd>{workedText(r.data.workedMinutes)}</dd></div>
                <div><dt>Today</dt><dd>{r.today}</dd></div>
              </dl>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// --- 5. Today's sessions ------------------------------------------------------

function TodaySessions({ today, timeZone, businessDate }) {
  return (
    <Panel id="dash-today" flush className="rx-db__table rx-db__table--today" title="Today’s sessions" hint={businessDateLabel(businessDate)} action={<ViewLink to="/scheduling">View schedule</ViewLink>}>
      {today.items.length === 0 ? (
        <EmptyBlock icon={Icon.Calendar} title="No sessions scheduled for today." body="Appointments booked for today appear here." />
      ) : (
        <>
          <div className="rx-st__listhead" aria-hidden="true">
            <span>Time</span><span>Client</span><span>Clinician</span><span>Status</span><span className="rx-st__listhead-actions">Actions</span>
          </div>
          <ul className="rx-st__list" aria-label="Today’s sessions">
            {today.items.map((r) => {
              const clientName = name(r.clientName, 'Client');
              const tone = SESSION_TONE[r.status] ?? 'accent';
              return (
                <li key={r.key} className="rx-st__row rx-db__row">
                  <div className="rx-st__cell rx-db__time" data-label="Time">{todayTimeText(r, timeZone)}</div>
                  <div className="rx-st__who">
                    <span className="rx-cl__avatar rx-cl__avatar--active" aria-hidden="true">{initials(clientName)}</span>
                    <div className="rx-st__who-text"><span className="rx-st__name">{clientName}</span></div>
                  </div>
                  <div className="rx-st__cell" data-label="Clinician">
                    {r.role && <span className={`rx-st__role rx-st__role--${r.role.toLowerCase()}`}>{r.role}</span>}
                    <span>{name(r.clinicianName)}</span>
                  </div>
                  <div className="rx-st__cell" data-label="Status">
                    <Badge tone={tone}>{statusLabel(r.status)}</Badge>
                    {r.source === 'MANUAL' && <span className="rx-ss__tag">Manual</span>}
                  </div>
                  <div className="rx-st__actions">
                    {r.sessionId
                      ? <Link className="rx-st__action rx-st__action--primary" to={`/sessions/${r.sessionId}`} aria-label={`View session for ${clientName}`}>View <Icon.Arrow size={14} /></Link>
                      : <span className="rx-st__muted">Not started</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          <MoreNote shown={today.items.length} total={today.total} to="/scheduling" label="View schedule" />
        </>
      )}
    </Panel>
  );
}

// --- 6. Clients needing attention ---------------------------------------------

function AttentionCard({ attention }) {
  return (
    <Panel id="dash-attention" title="Clients needing attention" hint="Required onboarding information is incomplete" action={<CountBadge value={attention.total} tone="pending" />}>
      {attention.items.length === 0 ? (
        <EmptyBlock icon={Icon.CheckCircle} title="No clients require attention." />
      ) : (
        <ul className="rx-db__items" aria-label="Clients needing attention">
          {attention.items.map((c) => {
            const clientName = name(c.clientName, 'Client');
            return (
              <li key={c.clientId} className={`rx-db__item rx-db__item--${c.severity === 'CRITICAL' ? 'critical' : 'warning'}`}>
                <div className="rx-db__item-main">
                  <div className="rx-db__item-title">
                    <Link className="rx-st__name" to={`/clients/${c.clientId}`}>{clientName}</Link>
                    <Badge status={c.status}>{CLIENT_STATUS_LABEL[c.status] ?? statusLabel(c.status)}</Badge>
                  </div>
                  <ul className="rx-db__reasons" aria-label="Missing information">
                    {c.missing.map((m) => <li key={m.code}>{m.label}</li>)}
                  </ul>
                </div>
                <Link className="rx-st__action" to={`/clients/${c.clientId}`} aria-label={`View client ${clientName}`}>View client</Link>
              </li>
            );
          })}
        </ul>
      )}
      <MoreNote shown={attention.items.length} total={attention.total} to="/clients" label="View all clients" />
    </Panel>
  );
}

// --- 7. Expiring authorizations -----------------------------------------------

function ExpiringAuthorizationsCard({ expiring }) {
  return (
    <Panel id="dash-authorizations" title="Expiring authorizations" hint="Authorizations nearing their end date" action={<CountBadge value={expiring.total} tone="pending" />}>
      {expiring.items.length === 0 ? (
        <EmptyBlock icon={Icon.Shield} title="No authorizations require attention." />
      ) : (
        <ul className="rx-db__items" aria-label="Expiring authorizations">
          {expiring.items.map((a) => {
            const clientName = name(a.clientName, 'Client');
            return (
              <li key={a.authorizationId} className="rx-db__item">
                <div className="rx-db__item-main">
                  <div className="rx-db__item-title">
                    <Link className="rx-st__name" to={`/clients/${a.clientId}`}>{clientName}</Link>
                    <Badge tone={a.daysLeft <= 7 ? 'denied' : 'pending'}>{a.daysLeft === 0 ? 'Expires today' : `In ${plural(a.daysLeft, 'day')}`}</Badge>
                  </div>
                  <div className="rx-db__meta">
                    {[a.serviceType, a.authorizationNumber ? `#${a.authorizationNumber}` : a.billingCode, AUTH_STATUS_LABEL[a.status] ?? statusLabel(a.status)].filter(Boolean).join(' · ')}
                  </div>
                  <div className="rx-db__meta">Expires {formatDate(a.endDate)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <MoreNote shown={expiring.items.length} total={expiring.total} />
    </Panel>
  );
}

// --- 8. BCBA Appointment Notes ------------------------------------------------

function AppointmentNotesCard({ notes, businessDate, timeZone }) {
  const [open, setOpen] = useState(null);
  return (
    <Panel id="dash-notes" title="BCBA Appointment Notes" hint="Added today" action={<CountBadge value={notes.total} tone="info" />}>
      {notes.items.length === 0 ? (
        <EmptyBlock icon={Icon.Clipboard} title="No appointment notes today." />
      ) : (
        <ul className="rx-db__items" aria-label="BCBA Appointment Notes">
          {notes.items.map((n) => {
            const first = formatFirstName(n.authorFirstName);
            const label = first ? `${first} has added notes` : 'A BCBA has added notes';
            return (
              <li key={n.noteId}>
                <button type="button" className="rx-db__note" onClick={() => setOpen(n)} aria-label={`${label} — open the note`}>
                  <span className="rx-st__avatar rx-st__avatar--bcba rx-db__note-avatar" aria-hidden="true">{initials(first || 'BCBA')}</span>
                  <span className="rx-db__note-body">
                    <span className="rx-db__note-msg">{label}</span>
                    {n.updatedAt && <span className="rx-db__meta">{formatTime(n.updatedAt, timeZone)}</span>}
                  </span>
                  <Icon.Arrow size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title="Appointment Note" size="md">
        {open && <AppointmentNoteReadOnly appointmentId={open.appointmentId} businessDate={businessDate} />}
      </Modal>
    </Panel>
  );
}

// --- 9. Latest sessions (the Sessions page's own rows) ------------------------

function LatestSessions({ sessions, timeZone }) {
  return (
    <section className="rx-db__section" aria-labelledby="dash-latest-title">
      <div className="rx-db__section-head">
        <div><h2 id="dash-latest-title" className="rx-card__title">Latest sessions</h2><p className="rx-card__hint">The most recent sessions, with worked time from the session record</p></div>
        <ViewLink to="/sessions">View all sessions</ViewLink>
      </div>
      {sessions.length === 0 ? (
        <Card pad={false}><EmptyBlock icon={Icon.Clipboard} title="No sessions recorded yet." body="Sessions appear here as soon as clinicians record them." /></Card>
      ) : (
        <ul className="rx-ss__list" aria-label="Latest sessions">
          {sessions.map((s) => (
            <SessionRow key={s.sessionId} timeZone={timeZone}
              row={{ id: s.sessionId, childName: s.clientName, clinicianName: s.clinicianName, role: s.role, startedAt: s.startedAt, actualStart: s.clockIn ?? s.startedAt, actualEnd: s.clockOut ?? s.endedAt, workedMinutes: s.workedMinutes, status: s.status, source: s.source }} />
          ))}
        </ul>
      )}
    </section>
  );
}

// --- shared -------------------------------------------------------------------

function MoreNote({ shown, total, to, label }) {
  if (!total || shown >= total) return null;
  return (
    <div className="rx-db__more">
      Showing {shown} of {total}
      {to && <> · <Link to={to}>{label}</Link></>}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="rx-db__skeleton" aria-busy="true" aria-label="Loading dashboard">
      <div className="rx-cl__summary">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel rx-cl__stat-skel" />)}</div>
      <div className="rx-db__grid rx-db__grid--3">{[0, 1, 2].map((i) => <div key={i} className="rx-skel rx-db__skel-panel" />)}</div>
      <div className="rx-skel rx-db__skel-panel" />
    </div>
  );
}

export default CompanyDashboardPage;
