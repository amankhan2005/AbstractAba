import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePermissions } from '@/auth/permissions';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { listAppointments, listClients, listStaff, listAuthorizations, bookAppointment, createServiceAuthorization, listCareTeam } from '@/api/client';
import { useToast } from '@/components';
import { useAuthStore, useOrgTimezone } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { Badge, Button, Icon, Modal, Field, TextInput, Select, Spinner, ErrorState, DateInput } from '@/ui';
import { buildBookingPayload, missingBookingFields, authorizationLabel } from './bookingPayload.js';
import { AppointmentNotePanel } from './AppointmentNotePanel.jsx';
import { AppointmentNotesOverview } from './AppointmentNotesOverview.jsx';
import { AppointmentEditor, applyAppointmentToCaches } from './AppointmentEditor.jsx';
import {
  WEEKDAYS, STATUS_LABEL, STATUS_TONE, bucketByDay, compareAppointments, dateSpanLabel, fetchAppointmentRange,
  gridRange, longDateLabel, monthGrid, monthLabel, monthOf, parseKey, scheduledTimeLabel, shiftMonth,
} from './calendarModel.js';
import { currentMonthBookingWindow } from '@/lib/businessDate';
import { useBusinessDate } from '@/lib/useBusinessDate';
import { formatDate, formatFullName, formatPersonName } from '@/lib/format';

/**
 * SCHEDULING — calendar-first appointment planning.
 *
 * Data: ONE range query per visible month grid through the existing
 * GET /v1/scheduling/appointments (from/to, paged at 100 with its cursor). Each
 * appointment already carries its client and clinician names, so the calendar
 * never fetches appointments one by one. Everything is placed on the
 * ORGANIZATION's business calendar (never the browser's timezone).
 *
 * Layout: header + Book Appointment → toolbar (month navigation, view, filters)
 * → month grid beside a selected-date panel (stacked on smaller screens).
 * Booking writes through the existing POST endpoint (one clinician per new
 * appointment); rescheduling through the existing versioned PATCH. The saved
 * appointment is placed into the loaded calendar at once, then the range is
 * refetched in the background.
 */

const STATUS_OPTS = [
  { value: '', label: 'All statuses' }, { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'COMPLETED', label: 'Completed' }, { value: 'CANCELLED', label: 'Cancelled' }, { value: 'NO_SHOW', label: 'No show' },
];
const name = (v) => formatPersonName(v || '') || '';

export function SchedulingRedesign() {
  const qc = useQueryClient();
  const toast = useToast();
  // Only the scheduling authority (Company/Admin, scheduler, receptionist) may
  // create appointments. Clinicians (BCBA/RBT) get a view-only calendar — the
  // booking UI is hidden and the backend independently rejects any write.
  const { can } = usePermissions();
  const canBook = can('scheduling.write');
  // BCBA / RBT see their own schedule (the server scopes appointments to the
  // clinician's assignment), so the clinician filter is not offered to them.
  const roles = useAuthStore((s) => s.principal?.roles) ?? [];
  const clinician = shellForRoles(roles) !== 'company';
  const orgTimeZone = useOrgTimezone() || 'UTC';
  const todayKey = useBusinessDate(orgTimeZone);

  const [cursor, setCursor] = useState(() => monthOf(todayKey));
  const [selectedDay, setSelectedDay] = useState(todayKey);
  const [view, setView] = useState('month');
  const [clientId, setClientId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [status, setStatus] = useState('');
  const [booking, setBooking] = useState(false);
  const [editing, setEditing] = useState(null); // appointment being rescheduled
  const [justSaved, setJustSaved] = useState(null); // id of the appointment to highlight
  const panelRef = useRef(null);

  const grid = useMemo(() => monthGrid(cursor), [cursor]);
  const range = useMemo(() => gridRange(grid, orgTimeZone), [grid, orgTimeZone]);
  const params = { ...range, ...(clientId ? { clientId } : {}), ...(staffId ? { staffProfileId: staffId } : {}), ...(status ? { status } : {}) };
  const appts = useQuery({
    queryKey: ['appointments', 'cal', params],
    queryFn: () => fetchAppointmentRange(listAppointments, params),
    placeholderData: keepPreviousData,
    // Moving between months reuses a recently loaded range instead of refetching it;
    // booking, rescheduling and cancelling invalidate ['appointments'] straight away.
    staleTime: 30_000,
  });
  // Filter + booking options (the server's maximum page size).
  const clients = useQuery({ queryKey: ['clients', 'opts', 100], queryFn: () => listClients({ limit: 100 }) });
  const staff = useQuery({ queryKey: ['staff', 'opts', 100], queryFn: () => listStaff({ limit: 100 }) });

  const clientOpts = [{ value: '', label: 'All clients' }, ...((clients.data?.items ?? []).map((c) => ({ value: c.id, label: formatFullName(c) })))];
  const staffOpts = [{ value: '', label: 'All clinicians' }, ...((staff.data?.items ?? []).map((s) => ({ value: s.id, label: formatFullName(s), hint: s.discipline })))];
  const clientNameById = useMemo(() => new Map((clients.data?.items ?? []).map((c) => [c.id, formatFullName(c)])), [clients.data]);
  const staffNameById = useMemo(() => new Map((staff.data?.items ?? []).map((s) => [s.id, formatFullName(s)])), [staff.data]);

  // Names come with each appointment; the option lists are only a fallback.
  const events = useMemo(() => (appts.data?.items ?? []).map((e) => ({
    ...e,
    clientName: e.clientName || clientNameById.get(e.clientId) || null,
    bcbaName: e.bcbaName || (e.bcbaId ? staffNameById.get(e.bcbaId) : null) || null,
    rbtName: e.rbtName || (e.rbtId ? staffNameById.get(e.rbtId) : null) || null,
  })), [appts.data, clientNameById, staffNameById]);
  const byDay = useMemo(() => bucketByDay(events, orgTimeZone), [events, orgTimeZone]);

  const monthPrefix = `${cursor.year}-${String(cursor.month).padStart(2, '0')}`;
  const monthEvents = useMemo(() => {
    const seen = new Map();
    for (const [key, list] of byDay) if (key.startsWith(monthPrefix)) for (const e of list) seen.set(e.id, e);
    return [...seen.values()].sort(compareAppointments);
  }, [byDay, monthPrefix]);
  const counts = useMemo(() => monthEvents.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }), {}), [monthEvents]);

  const selectDay = (key, { reveal = false } = {}) => {
    setSelectedDay(key);
    const m = monthOf(key);
    if (m.year !== cursor.year || m.month !== cursor.month) setCursor(m);
    if (reveal && typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1100px)').matches) {
      panelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
  };
  const goMonth = (n) => setCursor((c) => shiftMonth(c, n));
  const goToday = () => { setCursor(monthOf(todayKey)); setSelectedDay(todayKey); };

  // Arrow-key navigation across the grid (roving focus).
  const gridRef = useRef(null);
  function onGridKey(e) {
    const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (!(e.key in deltas)) return;
    e.preventDefault();
    const idx = grid.indexOf(focusKey);
    const next = grid[Math.min(41, Math.max(0, (idx < 0 ? 0 : idx) + deltas[e.key]))];
    setSelectedDay(next);
    window.requestAnimationFrame?.(() => gridRef.current?.querySelector(`[data-date="${next}"]`)?.focus());
  }

  // The one tabbable date (roving focus): the selected date when visible, else today, else the 1st.
  const focusKey = grid.includes(selectedDay) ? selectedDay : grid.includes(todayKey) && monthOf(todayKey).month === cursor.month ? todayKey : `${cursor.year}-${String(cursor.month).padStart(2, '0')}-01`;
  const dayEvents = byDay.get(selectedDay) ?? [];
  const selectedMonth = monthOf(selectedDay);
  const { today: firstBookable, lastAllowed } = currentMonthBookingWindow(orgTimeZone, new Date());
  const selectedBookable = selectedDay >= firstBookable && selectedDay <= lastAllowed;

  return (
    <div className="rx-sch">
      <header className="rx-sch__head">
        <div className="rx-sch__head-text">
          <h1 className="rx-sch__title">{clinician ? 'Schedule' : 'Scheduling'}</h1>
          <p className="rx-sch__subtitle">{clinician ? 'Your appointments. Select a date to see its details.' : 'Appointments for your clients and clinicians, on one calendar.'}</p>
        </div>
        {canBook ? <Button icon={Icon.Plus} onClick={() => setBooking(true)}>Book Appointment</Button> : null}
      </header>

      <div className="rx-sch__toolbar">
        <div className="rx-sch__nav">
          <button type="button" className="rx-sch__icon-btn rx-sch__icon-btn--prev" onClick={() => goMonth(-1)} aria-label="Previous month"><Icon.Arrow size={16} /></button>
          <h2 className="rx-sch__month" aria-live="polite">{monthLabel(cursor)}</h2>
          <button type="button" className="rx-sch__icon-btn" onClick={() => goMonth(1)} aria-label="Next month"><Icon.Arrow size={16} /></button>
          <Button variant="ghost" size="sm" onClick={goToday}>Today</Button>
        </div>
        <div className="rx-sch__views" role="group" aria-label="Calendar view">
          {[['month', 'Month'], ['list', 'List']].map(([id, label]) => (
            <button key={id} type="button" className={`rx-sch__view${view === id ? ' is-active' : ''}`} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
        <div className="rx-sch__filters">
          <div className="rx-sch__filter"><Select value={clientId} onChange={setClientId} options={clientOpts} loading={clients.isLoading} placeholder="All clients" /></div>
          {!clinician && <div className="rx-sch__filter"><Select value={staffId} onChange={setStaffId} options={staffOpts} loading={staff.isLoading} placeholder="All clinicians" /></div>}
          <div className="rx-sch__filter"><Select value={status} onChange={setStatus} options={STATUS_OPTS} searchable={false} placeholder="All statuses" /></div>
        </div>
      </div>

      <dl className="rx-sch__stats" aria-label={`${monthLabel(cursor)} summary`}>
        <div className="rx-sch__stat"><dt>Appointments</dt><dd>{appts.isLoading ? '—' : monthEvents.length}</dd></div>
        {['SCHEDULED', 'COMPLETED', 'CANCELLED'].map((s) => (
          <div key={s} className={`rx-sch__stat rx-sch__stat--${STATUS_TONE[s]}`}><dt>{STATUS_LABEL[s]}</dt><dd>{appts.isLoading ? '—' : counts[s] ?? 0}</dd></div>
        ))}
      </dl>

      <div className="rx-sch__layout">
        <section className="rx-sch__calendar" aria-label="Calendar">
          {appts.isError && !appts.data ? (
            <ErrorState title="We couldn’t load appointments" onRetry={() => appts.refetch()} />
          ) : view === 'month' ? (
            <>
              <div className="rx-sch__weekdays" aria-hidden="true">{WEEKDAYS.map((d) => <span key={d}>{d}</span>)}</div>
              <div className={`rx-sch__grid${appts.isFetching ? ' is-refreshing' : ''}`} ref={gridRef} role="grid" aria-label={monthLabel(cursor)} aria-busy={appts.isLoading} onKeyDown={onGridKey}>
                {Array.from({ length: 6 }, (_, w) => (
                  <div key={w} role="row" className="rx-sch__week">
                    {grid.slice(w * 7, w * 7 + 7).map((key) => {
                      const list = byDay.get(key) ?? [];
                      const { d, m } = parseKey(key);
                      const out = m !== cursor.month;
                      const isToday = key === todayKey;
                      const isSelected = key === selectedDay;
                      return (
                        <div key={key} role="gridcell" aria-selected={isSelected} className="rx-sch__cell-wrap">
                          <button type="button" data-date={key}
                            className={`rx-sch__cell${out ? ' is-out' : ''}${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}${list.length ? ' has-events' : ''}`}
                            tabIndex={key === focusKey ? 0 : -1} aria-pressed={isSelected} aria-current={isToday ? 'date' : undefined}
                            aria-label={`${longDateLabel(key)}${isToday ? ' (today)' : ''}, ${list.length === 0 ? 'no appointments' : `${list.length} appointment${list.length === 1 ? '' : 's'}`}`}
                            onClick={() => selectDay(key, { reveal: true })}>
                            <span className="rx-sch__date">{d}</span>
                            {appts.isLoading ? null : (
                              <>
                                <span className="rx-sch__chips" aria-hidden="true">
                                  {list.slice(0, 2).map((e) => (
                                    <span key={e.id} className={`rx-sch__chip rx-sch__chip--${STATUS_TONE[e.status] ?? 'draft'}`}>
                                      {scheduledTimeLabel(e, orgTimeZone).split(' – ')[0] ? <b>{scheduledTimeLabel(e, orgTimeZone).split(' – ')[0]}</b> : null}
                                      {name(e.clientName) || STATUS_LABEL[e.status] || 'Appointment'}
                                    </span>
                                  ))}
                                  {list.length > 2 && <span className="rx-sch__more">+{list.length - 2} more</span>}
                                </span>
                                {list.length > 0 && (
                                  <span className="rx-sch__dots" aria-hidden="true">
                                    {list.slice(0, 3).map((e) => <i key={e.id} className={`rx-sch__dot rx-sch__dot--${STATUS_TONE[e.status] ?? 'draft'}`} />)}
                                  </span>
                                )}
                              </>
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              {!appts.isLoading && !appts.isError && monthEvents.length === 0 && (
                <p className="rx-sch__grid-empty">No appointments in {monthLabel(cursor)}{clientId || staffId || status ? ' for these filters' : ''}.</p>
              )}
              {appts.data && !appts.data.complete && <p className="rx-sch__grid-empty" role="status">Showing the first 2,000 appointments in this range. Use the filters to narrow it down.</p>}
            </>
          ) : (
            <MonthList events={monthEvents} loading={appts.isLoading} month={cursor} timeZone={orgTimeZone} onOpen={(e, key) => selectDay(key, { reveal: true })} />
          )}
        </section>

        <aside className="rx-sch__panel" ref={panelRef} aria-label="Selected date">
          <DayPanel dayKey={selectedDay} events={dayEvents} loading={appts.isLoading} todayKey={todayKey} timeZone={orgTimeZone}
            canBook={canBook} canBookDay={selectedBookable} justSaved={justSaved}
            outsideMonth={selectedMonth.month !== cursor.month || selectedMonth.year !== cursor.year}
            onBook={() => setBooking(true)} onReschedule={(e) => setEditing(e)} />
        </aside>
      </div>

      {/* Company Admin: the CURRENT business date's appointment notes (server-resolved date). */}
      {canBook ? <AppointmentNotesOverview /> : null}

      {canBook ? (
        <BookingModal open={booking} onClose={() => setBooking(false)} clientOpts={clientOpts.slice(1)}
          initialDate={selectedBookable ? selectedDay : ''}
          onBook={async (body, meta = {}) => {
            // Let a rejection propagate to the modal's submit() so the SPECIFIC
            // backend reason is shown inline and the form stays open for a fix +
            // retry. Only the success side-effects live here.
            const created = await bookAppointment(body);
            if (created?.id) {
              applyAppointmentToCaches(qc, { ...created, clientName: created.clientName ?? meta.clientName ?? null, bcbaName: created.bcbaName ?? meta.bcbaName ?? null, rbtName: created.rbtName ?? meta.rbtName ?? null });
              setJustSaved(created.id);
            }
            qc.invalidateQueries({ queryKey: ['appointments'] });
            toast.push('Appointment created successfully.');
            setBooking(false);
            if (body.startDate) selectDay(body.startDate);
          }} />
      ) : null}

      {editing && (
        <AppointmentEditor appointmentId={editing.id} seed={editing} onCancel={() => setEditing(null)}
          onSaved={(updated, message) => {
            setEditing(null); setJustSaved(updated.id); toast.push(message);
            if (updated.startAt && updated.status !== 'CANCELLED') selectDay(new Intl.DateTimeFormat('en-CA', { timeZone: orgTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(updated.startAt)));
          }} />
      )}
    </div>
  );
}

function DayPanel({ dayKey, events, loading, todayKey, timeZone, canBook, canBookDay, justSaved, outsideMonth, onBook, onReschedule }) {
  // Appointment Notes exist only for the CURRENT business date, so note actions
  // appear only in today's view — never on another date of a multi-date appointment.
  const isToday = dayKey === todayKey;
  return (
    <div className="rx-sch__day">
      <div className="rx-sch__day-head">
        <div>
          <span className="rx-sch__day-k">{isToday ? 'Today' : 'Selected date'}</span>
          <h2 className="rx-sch__day-title">{longDateLabel(dayKey)}</h2>
          <span className="rx-sch__day-count" role="status">{loading ? 'Loading appointments…' : `${events.length} appointment${events.length === 1 ? '' : 's'}`}</span>
        </div>
        {canBook && canBookDay ? <Button size="sm" variant="subtle" icon={Icon.Plus} onClick={onBook}>Book</Button> : null}
      </div>
      {outsideMonth && <p className="rx-sch__day-hint">This date is outside the month shown in the calendar.</p>}
      {loading ? (
        <div className="rx-sch__day-list" aria-busy="true">{[0, 1].map((i) => <div key={i} className="rx-skel rx-sch__appt-skel" />)}</div>
      ) : events.length === 0 ? (
        <div className="rx-sch__empty">
          <span className="rx-sch__empty-icon" aria-hidden="true"><Icon.Calendar size={22} /></span>
          <strong>Nothing scheduled</strong>
          <span>There are no appointments on this date.</span>
          {canBook && canBookDay ? <Button size="sm" icon={Icon.Plus} onClick={onBook}>Book Appointment</Button> : null}
        </div>
      ) : (
        <ul className="rx-sch__day-list">
          {events.map((e) => (
            <li key={e.id} className={`rx-sch__appt rx-sch__appt--${STATUS_TONE[e.status] ?? 'draft'}${justSaved === e.id ? ' is-new' : ''}`}>
              <div className="rx-sch__appt-top">
                <div className="rx-sch__appt-main">
                  <span className="rx-sch__appt-client">{name(e.clientName) || 'Client'}</span>
                  {(scheduledTimeLabel(e, timeZone) || dateSpanLabel(e, timeZone)) && (
                    <span className="rx-sch__appt-when"><Icon.Clock size={13} aria-hidden="true" />{scheduledTimeLabel(e, timeZone) || dateSpanLabel(e, timeZone)}</span>
                  )}
                </div>
                <Badge tone={STATUS_TONE[e.status] ?? 'draft'}>{STATUS_LABEL[e.status] ?? e.status}</Badge>
              </div>
              <div className="rx-sch__appt-people">
                {e.bcbaId ? <span className="rx-sch__person"><i className="rx-sch__role rx-sch__role--bcba">BCBA</i>{name(e.bcbaName) || 'Not available'}</span> : null}
                {e.rbtId ? <span className="rx-sch__person"><i className="rx-sch__role rx-sch__role--rbt">RBT</i>{name(e.rbtName) || 'Not available'}</span> : null}
              </div>
              <div className="rx-sch__appt-meta">
                {e.units ? <span>{e.units} unit{e.units === 1 ? '' : 's'}</span> : null}
                {e.authorizationIds?.length ? <span>{e.authorizationIds.length} authorization{e.authorizationIds.length === 1 ? '' : 's'}</span> : null}
                <span className="rx-sch__appt-actions">
                  <Link className="rx-sch__link" to={`/scheduling/appointments/${e.id}`}>View</Link>
                  {canBook && e.status === 'SCHEDULED' ? <button type="button" className="rx-sch__link" onClick={() => onReschedule(e)}>Reschedule</button> : null}
                </span>
              </div>
              {/* The current business date's note for this appointment (server-resolved date). */}
              {isToday ? <AppointmentNotePanel appointmentId={e.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MonthList({ events, loading, month, timeZone, onOpen }) {
  if (loading) return <div className="rx-sch__list" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="rx-skel rx-sch__appt-skel" />)}</div>;
  if (events.length === 0) return <div className="rx-sch__empty"><span className="rx-sch__empty-icon" aria-hidden="true"><Icon.Calendar size={22} /></span><strong>No appointments</strong><span>Nothing is scheduled in {monthLabel(month)}.</span></div>;
  const groups = new Map();
  const prefix = `${month.year}-${String(month.month).padStart(2, '0')}`;
  for (const e of events) {
    const key = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(e.startAt));
    const k = key.startsWith(prefix) ? key : `${prefix}-01`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return (
    <div className="rx-sch__list">
      {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => (
        <section key={key} className="rx-sch__list-group" aria-label={longDateLabel(key)}>
          <h3 className="rx-sch__list-date">{longDateLabel(key)}</h3>
          {list.map((e) => (
            <button key={e.id} type="button" className="rx-sch__list-row" onClick={() => onOpen(e, key)}>
              <i className={`rx-sch__dot rx-sch__dot--${STATUS_TONE[e.status] ?? 'draft'}`} aria-hidden="true" />
              <span className="rx-sch__list-client">{name(e.clientName) || 'Client'}</span>
              <span className="rx-sch__list-meta">{[e.bcbaId ? `BCBA ${name(e.bcbaName)}` : null, e.rbtId ? `RBT ${name(e.rbtName)}` : null, scheduledTimeLabel(e, timeZone) || dateSpanLabel(e, timeZone)].filter(Boolean).join(' · ')}</span>
              <Badge tone={STATUS_TONE[e.status] ?? 'draft'}>{STATUS_LABEL[e.status] ?? e.status}</Badge>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

const BOOKING_STEPS = [
  { id: 'client', title: 'Client', desc: 'Who the appointment is for.' },
  { id: 'clinician', title: 'Clinician', desc: 'One clinician per appointment.' },
  { id: 'authorization', title: 'Authorization', desc: 'The authorizations this appointment uses.' },
  { id: 'date', title: 'Date', desc: 'Today through the end of this month.' },
  { id: 'time', title: 'Time & Units', desc: 'Scheduled date and billable units.' },
];

export function BookingModal({ open, onClose, clientOpts, onBook, initialDate = '' }) {
  const [clientId, setClientId] = useState('');
  // ONE clinician per appointment (spec §4): the admin picks a TYPE (BCBA or
  // RBT) and then the single clinician of that type. To schedule both roles for
  // a client, book two separate appointments.
  const [clinicianRole, setClinicianRole] = useState('BCBA'); // 'BCBA' | 'RBT'
  const [clinicianId, setClinicianId] = useState('');
  const [authorizationIds, setAuthorizationIds] = useState([]);
  const [date, setDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [units, setUnits] = useState('4');
  // NEW appointments: today → end of the current month (org timezone). The
  // shared date picker disables every other date and month; the server
  // enforces the same window.
  const bookingTimeZone = useOrgTimezone();
  const { today: firstBookable, lastAllowed: lastBookable } = currentMonthBookingWindow(bookingTimeZone, new Date());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [invalid, setInvalid] = useState([]);

  // Avoid a state update after the parent unmounts this modal on success.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  // Synchronous single-flight guard for the booking submit (see submit()).
  const inFlightRef = useRef(false);

  // Load the client's authorizations in EVERY state (no status filter) so a
  // just-created ABA/FBA is visible. A saved authorization is usable immediately
  // (the server maps it to ACTIVE); only a DENIED one is not selectable and
  // surfaces as a hint. The backend re-enforces validity regardless.
  const auths = useQuery({
    queryKey: ['authorizations', clientId],
    queryFn: () => listAuthorizations({ clientId, limit: 100 }),
    enabled: Boolean(clientId),
  });
  const allAuths = auths.data?.items ?? [];
  const isBookableAuth = (a) => a.status === 'ACTIVE' || a.status === 'APPROVED';
  const bookableAuths = allAuths.filter(isBookableAuth);
  const deniedAuths = allAuths.filter((a) => !isBookableAuth(a));
  const toggleAuth = (id) => setAuthorizationIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // BCBA and RBT choices come ONLY from the client's CURRENT care team (assigned,
  // ACTIVE). Ended assignments are excluded. The backend re-validates the same
  // rule (BCBA_NOT_ASSIGNED / RBT_NOT_ASSIGNED), so this is UX, not the boundary.
  const careTeam = useQuery({
    queryKey: ['care-team', clientId],
    queryFn: () => listCareTeam(clientId),
    enabled: Boolean(clientId),
  });
  const activeAssignments = (careTeam.data ?? []).filter((a) => (a.status ?? 'ACTIVE') === 'ACTIVE');
  const roleOpts = (role) => activeAssignments
    .filter((a) => a.role === role)
    .map((a) => ({ value: a.staffProfileId, label: `${a.staffName || 'Assigned staff'} · ${role}` }));
  const bcbaOpts = roleOpts('BCBA');
  const rbtOpts = roleOpts('RBT');
  // Options for the CURRENTLY selected clinician type only — one clinician, one appointment.
  const clinicianOpts = clinicianRole === 'RBT' ? rbtOpts : bcbaOpts;
  const noClinician = Boolean(clientId) && !careTeam.isLoading && clinicianOpts.length === 0;
  const roleWord = clinicianRole === 'RBT' ? 'RBT' : 'BCBA';

  // Reset dependent selections whenever the client changes so a previous
  // client's clinician/authorizations can never linger.
  useEffect(() => { setClinicianId(''); setAuthorizationIds([]); setCreating(false); }, [clientId]);
  // Switching the clinician TYPE clears the chosen clinician so a BCBA id can
  // never be submitted as an RBT (or vice-versa).
  useEffect(() => { setClinicianId(''); }, [clinicianRole]);

  // The modal stays mounted (visibility via `open`); reset the whole form on
  // close so every open starts empty. Opening from a selected date pre-fills it.
  useEffect(() => {
    if (!open) {
      setClientId(''); setClinicianRole('BCBA'); setClinicianId(''); setAuthorizationIds([]);
      setDate(''); setEndDate(''); setUnits('4');
      setErr(''); setInvalid([]); setBusy(false); setCreating(false);
    } else if (initialDate) {
      setDate((d) => d || initialDate);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Inline authorization creation — writes the SAME authoritative ABA/FBA
  // ServiceAuthorization the Company screen writes and adds it to the selection
  // by its unified `svc:` id. It is usable the moment it is saved: no status is
  // changed here.
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [newAuth, setNewAuth] = useState({ serviceType: 'ABA', startDate: '', endDate: '', units: '160', authorizationNumber: '' });
  async function addServiceAuth(forClientId, form) {
    const body = {
      serviceType: form.serviceType,
      startDate: new Date(form.startDate).toISOString(),
      endDate: new Date(form.endDate).toISOString(),
      units: Number(form.units),
      ...(form.authorizationNumber.trim() ? { authorizationNumber: form.authorizationNumber.trim() } : {}),
    };
    const auth = await createServiceAuthorization(forClientId, body);
    return auth.id;
  }
  const createAuth = useMutation({
    mutationFn: (forClientId) => addServiceAuth(forClientId, newAuth),
    onSuccess: async (serviceAuthId) => {
      await qc.invalidateQueries({ queryKey: ['authorizations', clientId] });
      await auths.refetch();
      setAuthorizationIds((cur) => (cur.includes(`svc:${serviceAuthId}`) ? cur : [...cur, `svc:${serviceAuthId}`]));
      setCreating(false);
      toast.push('Authorization added.');
    },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'Could not create the authorization.', 'negative'),
  });
  function submitNewAuth() {
    if (!newAuth.startDate || !newAuth.endDate || !newAuth.units) return;
    createAuth.mutate(clientId);
  }

  async function submit() {
    if (inFlightRef.current) return; // synchronous single-flight (rapid double-click)
    // Exactly one clinician id is sent, chosen by the selected type. The other
    // is always empty — the backend rejects a payload carrying both.
    const bcbaId = clinicianRole === 'BCBA' ? clinicianId : '';
    const rbtId = clinicianRole === 'RBT' ? clinicianId : '';
    const missing = missingBookingFields({ clientId, bcbaId, rbtId, authorizationIds, startDate: date });
    const unitsNum = Number(units);
    if (!Number.isInteger(unitsNum) || unitsNum < 1) missing.push('units');
    setInvalid(missing);
    if (missing.length > 0) {
      setErr(missing.length === 1 && missing[0] === 'authorization' && clientId
        ? 'Please select at least one authorization.'
        : `Please complete: ${missing.map((m) => (m === 'child' ? 'client' : m)).join(', ')}.`);
      return;
    }
    if (date < firstBookable || (endDate && endDate < firstBookable)) {
      setErr('Appointments can’t be scheduled for a past date. Choose today or a later date this month.');
      return;
    }
    if (date > lastBookable || (endDate && endDate > lastBookable)) {
      setErr('Appointments can only be scheduled within the current month.');
      return;
    }
    inFlightRef.current = true;
    setErr(''); setBusy(true);
    try {
      const clinicianName = (clinicianOpts.find((o) => o.value === clinicianId)?.label ?? '').split(' · ')[0] || null;
      await onBook(
        buildBookingPayload({ clientId, bcbaId, rbtId, authorizationIds, startDate: date, endDate, units }),
        { clientName: clientOpts.find((o) => o.value === clientId)?.label ?? null, ...(bcbaId ? { bcbaName: clinicianName } : { rbtName: clinicianName }) },
      );
    } catch (e) {
      // onBook rejects on any booking failure (validation, tenant/client guard,
      // BCBA/RBT not assigned, authorization invalid). Surface the exact backend
      // reason inline; the finally below ALWAYS clears the spinner.
      if (mounted.current) setErr(e?.response?.data?.error?.message ?? 'Could not book this appointment. Please review the details and try again.');
    } finally {
      inFlightRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const noBookable = Boolean(clientId) && !auths.isLoading && bookableAuths.length === 0;
  const hasDenied = deniedAuths.length > 0;
  const canCreate = noBookable;
  const deniedHint = noBookable && hasDenied
    ? `${deniedAuths.length} authorization${deniedAuths.length === 1 ? ' was' : 's were'} denied — add a new authorization to book.`
    : null;

  const clientLabel = clientOpts.find((o) => o.value === clientId)?.label;
  const clinicianLabel = (clinicianOpts.find((o) => o.value === clinicianId)?.label ?? '').split(' · ')[0];
  const done = { client: Boolean(clientId), clinician: Boolean(clinicianId), authorization: authorizationIds.length > 0, date: Boolean(date), time: Number(units) >= 1 };
  const flagged = (id) => invalid.includes(id === 'client' ? 'child' : id);
  const unitsHours = Number.isFinite(Number(units)) && Number(units) > 0 ? Math.round(Number(units) * 25) / 100 : null;

  const step = (idx, children) => {
    const s = BOOKING_STEPS[idx];
    return (
      <section className={`rx-bk__step${done[s.id] ? ' is-done' : ''}${flagged(s.id) ? ' is-invalid' : ''}`} aria-labelledby={`bk-${s.id}`}>
        <div className="rx-bk__step-head">
          <span className="rx-bk__step-n" aria-hidden="true">{done[s.id] ? <Icon.Check size={13} /> : idx + 1}</span>
          <div>
            <h3 id={`bk-${s.id}`} className="rx-bk__step-title">{s.title}</h3>
            <p className="rx-bk__step-desc">{s.desc}</p>
          </div>
        </div>
        <div className="rx-bk__step-body">{children}</div>
      </section>
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Book Appointment" variant="drawer" size="xl"
      description="Choose the client, one clinician, the authorizations to use and the date. To schedule both a BCBA and an RBT, book two appointments."
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy} icon={Icon.Calendar}>Book Appointment</Button></>}>
      <div className="rx-bk">
        <div className="rx-bk__form">
          {step(0, (
            <Field label="Client" required><Select value={clientId} onChange={setClientId} options={clientOpts} placeholder="Select a client…" /></Field>
          ))}

          {step(1, (
            <>
              <div role="group" aria-label="Clinician type" className="rx-bk__roles">
                {['BCBA', 'RBT'].map((r) => (
                  <button key={r} type="button" className={`rx-bk__role${clinicianRole === r ? ' is-active' : ''}`} aria-pressed={clinicianRole === r} onClick={() => setClinicianRole(r)}>{r}</button>
                ))}
              </div>
              <p className="rx-bk__hint">An appointment is for one clinician. To schedule both roles for a client, book a second appointment.</p>
              <Field label={roleWord} required
                hint={!clientId ? 'Select a client first.' : noClinician ? `No assigned ${roleWord}` : `${clinicianOpts.length} assigned`}>
                <Select value={clinicianId} onChange={setClinicianId} options={clinicianOpts}
                  loading={careTeam.isLoading} disabled={!clientId || noClinician}
                  placeholder={!clientId ? 'Select a client first…' : noClinician ? `No assigned ${roleWord}` : `Select a ${roleWord}…`} />
              </Field>
            </>
          ))}

          {step(2, (
            <>
              <Field label="Authorizations" required hint={!clientId ? undefined : deniedHint
                ?? (canCreate ? 'This client has no authorization yet — create one before booking.'
                  : 'Select one or more ABA/FBA authorizations for this appointment.')}>
                {!clientId ? (
                  <p className="rx-bk__hint">Select a client first.</p>
                ) : auths.isLoading ? (
                  <Spinner />
                ) : bookableAuths.length === 0 ? (
                  <p className="rx-bk__hint">No authorizations available.</p>
                ) : (
                  <div role="group" aria-label="Authorizations" className="rx-bk__auths">
                    {bookableAuths.map((a) => (
                      <label key={a.id} className={`rx-bk__auth${authorizationIds.includes(a.id) ? ' is-checked' : ''}`}>
                        <input type="checkbox" checked={authorizationIds.includes(a.id)} onChange={() => toggleAuth(a.id)} aria-label={`Authorization ${a.authorizationNumber || a.id}`} />
                        <span>{authorizationLabel(a)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </Field>
              {canCreate && !creating && (
                <Button variant="subtle" icon={Icon.Plus} onClick={() => setCreating(true)}>Create authorization</Button>
              )}
              {canCreate && creating && (
                <div className="rx-bk__newauth">
                  <div className="rx-bk__newauth-title">New authorization</div>
                  <div className="rx-bk__grid">
                    <Field label="Service" required>
                      <Select value={newAuth.serviceType} onChange={(v) => setNewAuth((s) => ({ ...s, serviceType: v }))}
                        options={[{ value: 'ABA', label: 'ABA' }, { value: 'FBA', label: 'FBA' }]} />
                    </Field>
                    <Field label="Authorization number" hint="Optional"><TextInput value={newAuth.authorizationNumber} onChange={(e) => setNewAuth((s) => ({ ...s, authorizationNumber: e.target.value }))} /></Field>
                    <Field label="Start date" required><DateInput value={newAuth.startDate} onChange={(e) => setNewAuth((s) => ({ ...s, startDate: e.target.value }))} aria-label="Authorization start date" /></Field>
                    <Field label="End date" required><DateInput value={newAuth.endDate} onChange={(e) => setNewAuth((s) => ({ ...s, endDate: e.target.value }))} aria-label="Authorization end date" /></Field>
                    <Field label="Authorized units" required><TextInput type="number" min="1" value={newAuth.units} onChange={(e) => setNewAuth((s) => ({ ...s, units: e.target.value }))} /></Field>
                  </div>
                  <div className="rx-bk__row-end">
                    <Button variant="ghost" onClick={() => setCreating(false)} disabled={createAuth.isPending}>Cancel</Button>
                    <Button icon={Icon.Check} loading={createAuth.isPending} onClick={submitNewAuth}>Create &amp; select</Button>
                  </div>
                </div>
              )}
            </>
          ))}

          {step(3, (
            <div className="rx-bk__grid">
              <Field label="Start date" required><DateInput value={date} onChange={(e) => setDate(e.target.value)} min={firstBookable} max={lastBookable} aria-label="Appointment date" /></Field>
              <Field label="End date" hint="Defaults to the start date"><DateInput value={endDate} onChange={(e) => setEndDate(e.target.value)} min={date && date > firstBookable ? date : firstBookable} max={lastBookable} aria-label="Appointment end date" /></Field>
            </div>
          ))}

          {step(4, (
            <>
              <p className="rx-bk__info"><Icon.Clock size={15} aria-hidden="true" /><span>This is a date-only appointment: the scheduled date is recorded without a clock time. Worked time is captured from the clinician’s session.</span></p>
              <div className="rx-bk__grid">
                <Field label="Units" required hint="Billable 15-minute units (must be greater than 0)"><TextInput type="number" min="1" value={units} onChange={(e) => setUnits(e.target.value)} aria-label="Units" /></Field>
              </div>
            </>
          ))}

          {err && <p className="rx-formfield__err rx-bk__error" role="alert">{err}</p>}
        </div>

        <aside className="rx-bk__summary" aria-label="Appointment summary">
          <h3 className="rx-bk__summary-title">Appointment Summary</h3>
          <dl className="rx-bk__summary-list">
            <div><dt>Client</dt><dd className={clientLabel ? '' : 'is-empty'}>{clientLabel || 'Not selected'}</dd></div>
            <div><dt>{roleWord}</dt><dd className={clinicianLabel ? '' : 'is-empty'}>{clinicianLabel || 'Not selected'}</dd></div>
            <div><dt>Authorizations</dt><dd className={authorizationIds.length ? '' : 'is-empty'}>{authorizationIds.length ? `${authorizationIds.length} selected` : 'Not selected'}</dd></div>
            <div><dt>Date</dt><dd className={date ? '' : 'is-empty'}>{date ? (endDate && endDate !== date ? `${formatDate(date)} – ${formatDate(endDate)}` : formatDate(date)) : 'Not selected'}</dd></div>
            <div><dt>Units</dt><dd>{units || '—'}{unitsHours != null ? ` (${unitsHours} h)` : ''}</dd></div>
          </dl>
          <ol className="rx-bk__progress" aria-label="Progress">
            {BOOKING_STEPS.map((s) => <li key={s.id} className={done[s.id] ? 'is-done' : ''}>{s.title}</li>)}
          </ol>
        </aside>
      </div>
    </Modal>
  );
}

export default SchedulingRedesign;
