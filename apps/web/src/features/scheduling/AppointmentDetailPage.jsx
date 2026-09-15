import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '@/auth/permissions';
import { useAuthStore, useOrgTimezone } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { cancelAppointment, getAppointment, startBcbaSession } from '@/api/client';
import { useToast } from '@/components';
import { Badge, Button, Confirm, Icon } from '@/ui';
import { formatPersonName } from '@/lib/format';
import { civilDateString } from '@/lib/businessDate';
import { useBusinessDate } from '@/lib/useBusinessDate';
import { isStartableNow, isExpiredAppointment, startabilityLabel } from '@/lib/appointment';
import { useStartWindowClock } from '@/features/sessions/useStartWindowClock.js';
import { AppointmentNotePanel } from './redesign/AppointmentNotePanel.jsx';
import { applyAppointmentToCaches } from './redesign/AppointmentEditor.jsx';
import { STATUS_LABEL, STATUS_TONE, dateSpanLabel, longDateLabel, scheduledTimeLabel } from './redesign/calendarModel.js';
import { coveredDays } from './redesign/calendarDays.js';

const ADMIN_ROLES = ['owner', 'org_admin'];

/**
 * Which appointment actions the signed-in user is offered. Visibility only — the
 * API re-checks every action:
 *   • Reschedule / Cancel: scheduling.write (Company Admin, scheduler, receptionist).
 *   • Start / Resume session: the BCBA clinician workflow only — a BCBA role (not
 *     an administrative role) holding sessions.write, on a scheduled or
 *     in-progress appointment that names a BCBA. Company Admin holds
 *     sessions.write for oversight, which is why that permission alone must not
 *     decide it. The server additionally requires the appointment's bcbaId to be
 *     the caller's own staff profile (NOT_YOUR_APPOINTMENT otherwise).
 */
export function appointmentActions({ roles = [], can, appointment }) {
  const a = appointment ?? {};
  const scheduled = a.status === 'SCHEDULED';
  const clinician = roles.includes('bcba') && !roles.some((r) => ADMIN_ROLES.includes(r));
  return {
    reschedule: can('scheduling.write') && scheduled,
    cancel: can('scheduling.write') && scheduled,
    startSession: clinician && can('sessions.write') && Boolean(a.bcbaId) && (scheduled || a.status === 'IN_PROGRESS'),
    viewClient: can('clients.read') && Boolean(a.clientId),
  };
}

/** A single appointment: overview, client, staff, details and permitted actions. */
export function AppointmentDetailPage() {
  const { appointmentId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, ready } = usePermissions();
  const roles = useAuthStore((s) => s.principal?.roles) ?? [];
  // The clinician sidebar calls the calendar "Schedule".
  const backLabel = shellForRoles(roles) === 'company' ? 'Back to Scheduling' : 'Back to Schedule';
  const timeZone = useOrgTimezone() || 'UTC';
  const today = useBusinessDate(timeZone);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Loads from the URL alone — no dependence on Scheduling's state or cache.
  const query = useQuery({ queryKey: ['appointment', appointmentId], queryFn: () => getAppointment(appointmentId), enabled: Boolean(appointmentId) });
  const a = query.data;
  const now = useStartWindowClock(a ? [a] : null, timeZone);

  const cancelMutation = useMutation({
    mutationFn: () => cancelAppointment(appointmentId),
    onSuccess: (updated) => {
      setConfirmCancel(false);
      applyAppointmentToCaches(qc, { ...a, ...updated, status: updated?.status ?? 'CANCELLED' });
      qc.invalidateQueries({ queryKey: ['appointments'] });
      qc.invalidateQueries({ queryKey: ['appointment', appointmentId] });
      toast.push('Appointment cancelled.');
    },
    onError: (err) => { setConfirmCancel(false); toast.push(err?.response?.data?.error?.message ?? 'The appointment could not be cancelled.', 'negative'); },
  });

  // Start Session from the appointment (BCBA clinicians only): the SAME BCBA
  // session-start endpoint the panel uses — one canonical session, no duplicate.
  // An existing session (409) routes to the panel to resume it.
  const startMutation = useMutation({
    mutationFn: () => startBcbaSession(appointmentId),
    onSuccess: () => { navigate('/sessions/panel'); },
    onError: (err) => {
      const code = err?.response?.data?.error?.code;
      if (code === 'SESSION_ALREADY_COMPLETED' || err?.response?.status === 409) navigate('/sessions/panel');
    },
  });

  if (query.isLoading) return <DetailSkeleton />;
  if (query.isError) {
    const status = query.error?.response?.status;
    const notFound = status === 404 || status === 403;
    return (
      <div className="rx-ad">
        <Link to="/scheduling" className="rx-sp__back"><Icon.Return size={15} /> {backLabel}</Link>
        <div className="rx-ad__state" role="alert">
          <span className="rx-ad__state-icon" aria-hidden="true"><Icon.Calendar size={22} /></span>
          <h1 className="rx-ad__state-title">{notFound ? 'Appointment not found' : 'We couldn’t load this appointment'}</h1>
          <p className="rx-ad__muted">{notFound ? 'This appointment doesn’t exist or isn’t available to you.' : 'Check your connection and try again.'}</p>
          {notFound ? <Link className="rx-btn rx-btn--primary" to="/scheduling">{backLabel}</Link> : <Button onClick={() => query.refetch()}>Try again</Button>}
        </div>
      </div>
    );
  }

  const actions = ready ? appointmentActions({ roles, can, appointment: a }) : { reschedule: false, cancel: false, startSession: false, viewClient: false };
  const clientName = formatPersonName(a.clientName || '') || 'Client';
  const dateOnly = a.timeSet === false;
  const days = coveredDays(a.startAt, a.endAt, timeZone);
  const firstDay = days[0] ?? (a.startAt ? civilDateString(a.startAt, timeZone) : null);
  const dateLabel = dateSpanLabel(a, timeZone) || (firstDay ? longDateLabel(firstDay) : 'Not scheduled');
  const timeLabel = scheduledTimeLabel(a, timeZone);
  const coversToday = days.includes(today);
  const clinicians = [
    a.bcbaId ? { role: 'BCBA', name: a.bcbaName } : null,
    a.rbtId ? { role: 'RBT', name: a.rbtName } : null,
  ].filter(Boolean);
  if (clinicians.length === 0 && a.staffProfileId) clinicians.push({ role: 'Staff', name: a.staffName });
  const hours = a.units != null ? Math.round(a.units * 25) / 100 : null;
  const authCount = a.authorizationIds?.length ?? 0;
  const tone = STATUS_TONE[a.status] ?? 'draft';
  const startableNow = isStartableNow(a, timeZone, now);
  const expired = isExpiredAppointment(a, timeZone, now);
  const dayLabel = startabilityLabel(a, timeZone, now);

  return (
    <div className="rx-ad">
      <Link to="/scheduling" className="rx-sp__back"><Icon.Return size={15} /> {backLabel}</Link>

      <header className={`rx-ad__hero rx-ad__hero--${tone}`}>
        <div className="rx-ad__hero-main">
          <span className="rx-ad__hero-icon" aria-hidden="true"><Icon.Calendar size={24} /></span>
          <div className="rx-ad__hero-text">
            <div className="rx-ad__eyebrow-row">
              <span className="rx-ad__eyebrow">Appointment</span>
              <Badge tone={tone}>{STATUS_LABEL[a.status] ?? a.status}</Badge>
            </div>
            <h1 className="rx-ad__title">{clientName}</h1>
            <p className="rx-ad__when">
              <span>{dateLabel}</span>
              {timeLabel ? <span className="rx-ad__when-time"><Icon.Clock size={14} aria-hidden="true" />{timeLabel}</span> : null}
            </p>
          </div>
        </div>
        {(actions.reschedule || actions.cancel || actions.startSession) && (
          <div className="rx-ad__actions">
            {actions.startSession ? (
              <>
                <Button icon={Icon.Clock} onClick={() => startMutation.mutate()} disabled={startMutation.isPending || (a.status === 'SCHEDULED' && !startableNow)}>
                  {startMutation.isPending ? (a.status === 'IN_PROGRESS' ? 'Resuming…' : 'Starting…') : (a.status === 'IN_PROGRESS' ? 'Resume session' : 'Start session')}
                </Button>
                {a.status === 'SCHEDULED' && !startableNow && dayLabel ? <span className={`rx-ad__hint${expired ? ' is-expired' : ''}`} role="status">{dayLabel}</span> : null}
              </>
            ) : null}
            {actions.reschedule ? <Link className="rx-btn rx-btn--primary" to={`/scheduling/appointments/${appointmentId}/edit`}><Icon.Calendar size={16} />Reschedule</Link> : null}
            {actions.cancel ? <Button variant="ghost" className="rx-ad__cancel" onClick={() => setConfirmCancel(true)} disabled={cancelMutation.isPending}>Cancel</Button> : null}
          </div>
        )}
      </header>

      {startMutation.isError && startMutation.error?.response?.status !== 409 ? (
        <div role="alert" className="rx-ad__alert"><Icon.Bell size={16} aria-hidden="true" />{startMutation.error?.response?.data?.error?.message || 'Could not start the session.'}</div>
      ) : null}

      <dl className="rx-ad__facts">
        <Fact icon={Icon.Calendar} tone="violet" label="Scheduled Date" value={dateLabel} />
        <Fact icon={Icon.Clock} tone="blue" label="Scheduled Time" value={timeLabel || (dateOnly ? 'Date-only appointment' : 'Not set')} muted={!timeLabel} />
        <Fact icon={Icon.Chart} tone="teal" label="Units" value={a.units != null ? `${a.units} unit${a.units === 1 ? '' : 's'}${hours != null ? ` · ${hours} h` : ''}` : 'Not set'} muted={a.units == null} />
        <Fact icon={Icon.Shield} tone="amber" label="Service Code" value={a.serviceCode || 'Not set'} muted={!a.serviceCode} />
      </dl>

      <div className="rx-ad__layout">
        <section className="rx-ad__card" aria-labelledby="ad-details">
          <h2 id="ad-details" className="rx-ad__card-title"><Icon.Clipboard size={17} aria-hidden="true" /> Appointment Details</h2>
          <dl className="rx-ad__rows">
            <Row label="Status"><Badge tone={tone}>{STATUS_LABEL[a.status] ?? a.status}</Badge></Row>
            <Row label="Scheduled Date">{dateLabel}</Row>
            <Row label="Scheduled Time">{timeLabel || <span className="rx-ad__muted">{dateOnly ? 'No clock time — date-only appointment' : 'Not set'}</span>}</Row>
            {days.length > 1 ? <Row label="Covered Dates">{`${days.length} business days`}</Row> : null}
            <Row label="Units">{a.units != null ? `${a.units}${hours != null ? ` (${hours} hour${hours === 1 ? '' : 's'})` : ''}` : <span className="rx-ad__muted">Not set</span>}</Row>
            <Row label="Service Code">{a.serviceCode || <span className="rx-ad__muted">Not set</span>}</Row>
            <Row label="Authorizations">{authCount ? `${authCount} authorization${authCount === 1 ? '' : 's'}` : <span className="rx-ad__muted">None linked</span>}</Row>
            {a.seriesId ? <Row label="Recurring">Part of a recurring series</Row> : null}
            {a.notes ? <Row label="Notes"><span className="rx-ad__notes">{a.notes}</span></Row> : null}
          </dl>
          {/* The Appointment Note for the CURRENT business date (server-resolved), shown only
              when this appointment covers today and a note exists for this user. */}
          {coversToday ? <div className="rx-ad__note"><AppointmentNotePanel appointmentId={a.id} /></div> : null}
        </section>

        <div className="rx-ad__side">
          <section className="rx-ad__card" aria-labelledby="ad-client">
            <h2 id="ad-client" className="rx-ad__card-title"><Icon.Child size={17} aria-hidden="true" /> Client</h2>
            <div className="rx-ad__person">
              <span className="rx-ad__avatar" aria-hidden="true">{initials(clientName)}</span>
              <div className="rx-ad__person-text">
                <strong>{clientName}</strong>
                <span className="rx-ad__muted">Client</span>
              </div>
            </div>
            {actions.viewClient ? <Link className="rx-ad__link" to={`/clients/${a.clientId}`}>View Client <Icon.Arrow size={14} aria-hidden="true" /></Link> : null}
          </section>

          <section className="rx-ad__card" aria-labelledby="ad-staff">
            <h2 id="ad-staff" className="rx-ad__card-title"><Icon.Users size={17} aria-hidden="true" /> Staff</h2>
            {clinicians.length === 0 ? <p className="rx-ad__muted">No clinician assigned.</p> : (
              <ul className="rx-ad__staff">
                {clinicians.map((c) => (
                  <li key={c.role} className="rx-ad__person">
                    <span className={`rx-ad__avatar rx-ad__avatar--${c.role.toLowerCase()}`} aria-hidden="true">{initials(formatPersonName(c.name || '') || c.role)}</span>
                    <div className="rx-ad__person-text">
                      <strong>{formatPersonName(c.name || '') || 'Not available'}</strong>
                      <span className={`rx-ad__role rx-ad__role--${c.role.toLowerCase()}`}>{c.role}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <Confirm open={confirmCancel} tone="danger" title="Cancel this appointment?" confirmLabel="Cancel Appointment" busy={cancelMutation.isPending}
        message={`The appointment for ${clientName} on ${dateLabel} will be cancelled.`}
        onCancel={() => setConfirmCancel(false)} onConfirm={() => cancelMutation.mutate()} />
    </div>
  );
}

const initials = (name) => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '·';

function Fact({ icon: IconCmp, tone, label, value, muted }) {
  return (
    <div className={`rx-ad__fact rx-ad__fact--${tone}`}>
      <span className="rx-ad__fact-icon" aria-hidden="true"><IconCmp size={17} /></span>
      <div className="rx-ad__fact-text"><dt>{label}</dt><dd className={muted ? 'is-muted' : undefined}>{value}</dd></div>
    </div>
  );
}

function Row({ label, children }) {
  return <div className="rx-ad__row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function DetailSkeleton() {
  return (
    <div className="rx-ad" aria-busy="true" aria-label="Loading appointment">
      <div className="rx-skel" style={{ width: 140, height: 22, borderRadius: 8 }} />
      <div className="rx-skel" style={{ height: 132, borderRadius: 20 }} />
      <div className="rx-ad__facts">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel" style={{ height: 70, borderRadius: 14 }} />)}</div>
      <div className="rx-ad__layout"><div className="rx-skel" style={{ height: 320, borderRadius: 18 }} /><div className="rx-skel" style={{ height: 320, borderRadius: 18 }} /></div>
    </div>
  );
}

export default AppointmentDetailPage;
