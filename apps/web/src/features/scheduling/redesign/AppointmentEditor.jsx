import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelAppointment, getAppointment, updateAppointment } from '@/api/client';
import { useOrgTimezone } from '@/auth/store';
import { Badge, Button, Confirm, DateInput, Field, Icon, Modal, TextInput, Textarea } from '@/ui';
import { civilDateString, lastCoveredDateString, zonedWallTimeToUtc } from '@/lib/businessDate';
import { formatDate, formatPersonName } from '@/lib/format';
import { STATUS_LABEL, STATUS_TONE, addDays, parseKey, upsertInRange } from './calendarModel.js';

/**
 * RESCHEDULE / UPDATE APPOINTMENT — one editor for the Scheduling drawer and the
 * /scheduling/appointments/:id/edit page, on the EXISTING versioned
 * PATCH /v1/scheduling/appointments/:id (If-Match).
 *
 * Time semantics are preserved exactly:
 *   • DATE-ONLY (timeSet === false): dates only. The request carries the
 *     org-timezone midnight bounds of the chosen business dates (end exclusive);
 *     the server re-anchors them and never records a clock time.
 *   • TIMED: a date plus start and end times in the ORGANIZATION timezone.
 * The server re-validates the client, clinician and authorizations; its reason
 * is shown as-is when it refuses.
 */

const clock = (instant, zone) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(instant));
  const get = (t) => p.find((x) => x.type === t)?.value ?? '00';
  return `${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`;
};
const instantOf = (dateKey, hhmm, zone) => {
  const { y, m, d } = parseKey(dateKey);
  const [hh, mm] = (hhmm || '00:00').split(':').map(Number);
  return zonedWallTimeToUtc(y, m, d, hh, mm, 0, zone);
};

export function formFromAppointment(a, zone) {
  const dateOnly = a.timeSet === false;
  return {
    startDate: a.startAt ? civilDateString(a.startAt, zone) : '',
    endDate: a.startAt ? (dateOnly ? lastCoveredDateString(a.startAt, a.endAt, zone) : civilDateString(a.startAt, zone)) : '',
    startTime: !dateOnly && a.startAt ? clock(a.startAt, zone) : '',
    endTime: !dateOnly && a.endAt ? clock(a.endAt, zone) : '',
    units: a.units != null ? String(a.units) : '',
    notes: a.notes ?? '',
  };
}

/** Client-side checks mirroring the update schema; returns { field: message }. */
export function validateReschedule(form, { dateOnly }) {
  const e = {};
  if (!form.startDate) e.startDate = 'Choose the appointment date.';
  if (dateOnly) {
    if (form.endDate && form.startDate && form.endDate < form.startDate) e.endDate = 'The end date must be on or after the start date.';
  } else {
    if (!form.startTime) e.startTime = 'Enter the start time.';
    if (!form.endTime) e.endTime = 'Enter the end time.';
    else if (form.startTime && form.endTime <= form.startTime) e.endTime = 'The end time must be after the start time.';
  }
  const units = Number(form.units);
  if (!Number.isInteger(units) || units < 1 || units > 1000) e.units = 'Units must be a whole number between 1 and 1000.';
  if (form.notes.length > 2000) e.notes = 'Notes must be 2000 characters or fewer.';
  return e;
}

/** The PATCH body: only what changed. */
export function buildRescheduleBody(form, original, { dateOnly, zone }) {
  const startAt = dateOnly ? instantOf(form.startDate, '00:00', zone) : instantOf(form.startDate, form.startTime, zone);
  const endAt = dateOnly ? instantOf(addDays(form.endDate || form.startDate, 1), '00:00', zone) : instantOf(form.startDate, form.endTime, zone);
  const body = {};
  if (startAt.getTime() !== new Date(original.startAt).getTime() || endAt.getTime() !== new Date(original.endAt).getTime()) {
    body.startAt = startAt.toISOString();
    body.endAt = endAt.toISOString();
  }
  if (Number(form.units) !== Number(original.units)) body.units = Number(form.units);
  if (form.notes.trim() !== String(original.notes ?? '').trim()) body.notes = form.notes.trim();
  return body;
}

/** Keep every loaded calendar range in step with a saved appointment (no refetch needed to see it). */
export function applyAppointmentToCaches(qc, appt) {
  for (const [key] of qc.getQueriesData({ queryKey: ['appointments', 'cal'] })) {
    qc.setQueryData(key, (data) => upsertInRange(data, appt, key[2]));
  }
  qc.setQueryData(['appointment', appt.id], (cur) => ({ ...(cur ?? {}), ...appt }));
}

export function AppointmentEditor({ appointmentId, seed = null, onSaved, onCancel, variant = 'drawer' }) {
  const qc = useQueryClient();
  const zone = useOrgTimezone() || 'UTC';
  const detail = useQuery({ queryKey: ['appointment', appointmentId], queryFn: () => getAppointment(appointmentId), enabled: Boolean(appointmentId) });
  const appt = detail.data ? { ...(seed ?? {}), ...detail.data } : null;
  const dateOnly = appt?.timeSet === false;
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const hydratedVersion = useRef(null);

  useEffect(() => {
    if (!detail.data || hydratedVersion.current === detail.data.version) return;
    if (hydratedVersion.current !== null && !conflict) return; // never overwrite edits on a background refetch
    hydratedVersion.current = detail.data.version;
    setForm(formFromAppointment(detail.data, zone));
  }, [detail.data, zone, conflict]);

  const set = (key) => (e) => { const v = e.target.value; setForm((f) => ({ ...f, [key]: v })); setErrors((c) => ({ ...c, [key]: undefined })); };

  const done = (updated, message) => {
    applyAppointmentToCaches(qc, { ...(seed ?? {}), ...updated });
    qc.invalidateQueries({ queryKey: ['appointments'] });
    onSaved?.({ ...(seed ?? {}), ...updated }, message);
  };

  const save = useMutation({
    mutationFn: (body) => updateAppointment(appointmentId, body, appt.version),
    onSuccess: (updated) => done(updated, 'Appointment updated.'),
    onError: (err) => {
      const e = err?.response?.data?.error ?? {};
      if (err?.response?.status === 409 && e.code === 'VERSION_CONFLICT') {
        setConflict(true);
        setBanner('This appointment was changed by someone else. Load the latest version and try again.');
        return;
      }
      if (e.details?.fieldErrors) setErrors(Object.fromEntries(Object.entries(e.details.fieldErrors).map(([k, v]) => [k === 'startAt' ? 'startDate' : k === 'endAt' ? (dateOnly ? 'endDate' : 'endTime') : k, v?.[0]])));
      setBanner(typeof e.message === 'string' && e.message ? e.message : 'The appointment could not be updated. Please review the details and try again.');
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelAppointment(appointmentId),
    onSuccess: (updated) => { setConfirmCancel(false); done({ ...appt, ...updated, status: 'CANCELLED' }, 'Appointment cancelled.'); },
    onError: (err) => { setConfirmCancel(false); setBanner(err?.response?.data?.error?.message ?? 'The appointment could not be cancelled.'); },
  });

  function submit() {
    setBanner(null);
    const found = validateReschedule(form, { dateOnly });
    setErrors(found);
    if (Object.keys(found).length) { setBanner('Please correct the highlighted fields.'); return; }
    const body = buildRescheduleBody(form, appt, { dateOnly, zone });
    if (Object.keys(body).length === 0) { setBanner('No changes to save.'); return; }
    save.mutate(body);
  }

  async function loadLatest() {
    const res = await detail.refetch();
    if (res.data) { hydratedVersion.current = res.data.version; setForm(formFromAppointment(res.data, zone)); setConflict(false); setBanner(null); setErrors({}); }
  }

  const editable = appt?.status === 'SCHEDULED';
  const busy = save.isPending || cancel.isPending;
  const clinician = appt?.bcbaId ? { role: 'BCBA', name: appt.bcbaName } : appt?.rbtId ? { role: 'RBT', name: appt.rbtName } : { role: 'Clinician', name: appt?.staffName };

  const body = detail.isLoading || !form ? (
    <div className="rx-ae__loading" aria-busy="true" aria-label="Loading appointment"><div className="rx-skel" style={{ height: 88, borderRadius: 14 }} /><div className="rx-skel" style={{ height: 220, borderRadius: 14 }} /></div>
  ) : detail.isError ? (
    <div className="rx-sch__empty" role="alert"><strong>We couldn’t load this appointment</strong><Button variant="subtle" onClick={() => detail.refetch()}>Try again</Button></div>
  ) : (
    <div className="rx-ae">
      <div className="rx-ae__summary">
        <div className="rx-ae__summary-main">
          <span className="rx-ae__k">Client</span>
          <strong className="rx-ae__client">{formatPersonName(appt.clientName || '') || 'Client'}</strong>
          <span className="rx-ae__meta">{clinician.role}: {formatPersonName(clinician.name || '') || 'Not available'} · {appt.authorizationIds?.length || 0} authorization{appt.authorizationIds?.length === 1 ? '' : 's'}</span>
        </div>
        <Badge tone={STATUS_TONE[appt.status] ?? 'draft'}>{STATUS_LABEL[appt.status] ?? appt.status}</Badge>
      </div>

      {banner && (
        <div className="rx-ae__banner" role="alert">
          <Icon.Bell size={16} aria-hidden="true" /><span>{banner}</span>
          {conflict && <Button size="sm" variant="subtle" onClick={loadLatest} loading={detail.isFetching}>Load latest version</Button>}
        </div>
      )}
      {!editable && <p className="rx-ae__note">Only scheduled appointments can be rescheduled.</p>}

      <section className="rx-ae__section" aria-labelledby="ae-when">
        <h3 id="ae-when" className="rx-ae__title"><Icon.Calendar size={16} aria-hidden="true" /> Appointment Details</h3>
        {dateOnly ? (
          <>
            <div className="rx-ae__grid">
              <Field label="Start date" required error={errors.startDate} hint="MM/DD/YYYY">
                <DateInput value={form.startDate} onChange={set('startDate')} aria-label="Start date" disabled={!editable} />
              </Field>
              <Field label="End date" error={errors.endDate} hint="Leave as the start date for a single day">
                <DateInput value={form.endDate} onChange={set('endDate')} min={form.startDate || undefined} aria-label="End date" disabled={!editable} />
              </Field>
            </div>
            <p className="rx-ae__note"><Icon.Clock size={14} aria-hidden="true" /> Date-only appointment: no clock time is recorded. Worked time comes from the clinician’s session.</p>
          </>
        ) : (
          <>
            <div className="rx-ae__grid">
              <Field label="Date" required error={errors.startDate} hint="MM/DD/YYYY">
                <DateInput value={form.startDate} onChange={set('startDate')} aria-label="Start date" disabled={!editable} />
              </Field>
            </div>
            <div className="rx-ae__grid">
              <Field label="Scheduled start" required error={errors.startTime}>
                <TextInput type="time" value={form.startTime} onChange={set('startTime')} aria-label="Scheduled start" disabled={!editable} />
              </Field>
              <Field label="Scheduled end" required error={errors.endTime}>
                <TextInput type="time" value={form.endTime} onChange={set('endTime')} aria-label="Scheduled end" disabled={!editable} />
              </Field>
            </div>
            <p className="rx-ae__note"><Icon.Clock size={14} aria-hidden="true" /> Times are in your organization’s time zone ({zone}).</p>
          </>
        )}
        <div className="rx-ae__grid">
          <Field label="Units" required error={errors.units} hint="Billable 15-minute units">
            <TextInput type="number" min="1" max="1000" value={form.units} onChange={set('units')} aria-label="Units" disabled={!editable} />
          </Field>
        </div>
        <Field label="Notes" error={errors.notes}>
          <Textarea rows={3} value={form.notes} onChange={set('notes')} maxLength={2000} aria-label="Notes" disabled={!editable} />
        </Field>
      </section>
    </div>
  );

  const footer = (
    <>
      {editable && appt && <Button variant="ghost" className="rx-ae__cancel-appt" onClick={() => setConfirmCancel(true)} disabled={busy}>Cancel Appointment</Button>}
      <span className="rx-ae__spacer" />
      {variant === 'page' && <Button variant="ghost" onClick={onCancel} disabled={busy}>Close</Button>}
      {editable && appt && <Button icon={Icon.Check} onClick={submit} loading={save.isPending} disabled={busy}>Update Appointment</Button>}
    </>
  );

  const confirm = (
    <Confirm open={confirmCancel} tone="danger" title="Cancel this appointment?" confirmLabel="Cancel Appointment" busy={cancel.isPending}
      message={appt ? `The appointment for ${formatPersonName(appt.clientName || '') || 'this client'} on ${formatDate(form?.startDate || civilDateString(appt.startAt, zone))} will be cancelled.` : ''}
      onCancel={() => setConfirmCancel(false)} onConfirm={() => cancel.mutate()} />
  );

  if (variant === 'page') {
    return (
      <div className="rx-ae-page">
        {body}
        <div className="rx-ae-page__actions">{footer}</div>
        {confirm}
      </div>
    );
  }
  return (
    <>
      <Modal open onClose={confirmCancel ? undefined : onCancel} variant="drawer" size="lg" title="Reschedule Appointment"
        description="Change the date, time, units or notes. The client, clinician and authorizations stay the same." footer={footer}>
        {body}
      </Modal>
      {confirm}
    </>
  );
}

export default AppointmentEditor;
