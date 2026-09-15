import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAppointmentNote, listAppointmentNotesOverview } from '@/api/client';
import { Card, Icon, Modal, Spinner, ErrorState } from '@/ui';
import { useOrgTimezone } from '@/auth/store';
import { useBusinessDate } from '@/lib/useBusinessDate';
import { formatDate, formatFirstName, formatTime } from '@/lib/format';

/**
 * TODAY'S APPOINTMENT NOTES — the Company Admin view, as notification-style
 * entries: "Test1 has added notes".
 *
 * Every entry is a persisted AppointmentNote for the CURRENT business date
 * (resolved by the server). Its name is the note AUTHOR's persisted first name,
 * shown through the canonical formatter — never the appointment's BCBA, never an
 * id. Opening an entry reads that note and shows it READ-ONLY:
 *
 *   BCBA    the author's first name
 *   Client  the client the BCBA selected on the note — omitted when none was
 *           selected (the appointment's client is never inferred)
 *   Note    the exact persisted text
 *
 * Nothing renders when there are no current-day notes, or for a caller the
 * server refuses. No editor is ever mounted here.
 */
export function authorLabel(firstName) {
  const name = formatFirstName(firstName);
  return name ? `${name} has added notes` : 'A BCBA has added notes';
}

export function AppointmentNotesOverview() {
  const [open, setOpen] = useState(null);
  const timeZone = useOrgTimezone() || undefined;
  const businessDate = useBusinessDate(timeZone);
  const query = useQuery({
    // Scoped to the current business date so a list cached yesterday is never reused today.
    queryKey: ['appointment-notes-overview', businessDate],
    queryFn: () => listAppointmentNotesOverview(),
    retry: false,
  });

  if (query.isError && [401, 403].includes(query.error?.response?.status)) return null;
  // Newest first: the most recent note is the most relevant notification.
  const items = [...(query.data?.items ?? [])].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  if (query.isSuccess && items.length === 0) return null;

  const dateText = query.data?.businessDate ? formatDate(query.data.businessDate) : null;

  return (
    <>
      <Card title="Today's appointment notes" hint={dateText || undefined} style={{ marginTop: 16 }}>
        {query.isLoading ? <Spinner /> : query.isError ? <ErrorState onRetry={() => query.refetch()} /> : (
          <div className="rx-notesov__list" role="list">
            {items.map((n) => {
              const label = authorLabel(n.authorFirstName);
              return (
                <button
                  key={n.id}
                  type="button"
                  role="listitem"
                  className="rx-notesov__row"
                  aria-label={`${label} — open the note`}
                  onClick={() => setOpen(n)}
                >
                  <span className="rx-notesov__icon" aria-hidden="true"><Icon.Clipboard size={16} /></span>
                  <span className="rx-notesov__msg">{label}</span>
                  <span className="rx-notesov__meta">
                    {n.updatedAt && <span className="rx-notesov__time">{formatTime(n.updatedAt, timeZone)}</span>}
                    <Icon.Arrow size={14} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title="Appointment Note" size="md">
        {open && <AppointmentNoteReadOnly appointmentId={open.appointmentId} businessDate={businessDate} />}
      </Modal>
    </>
  );
}

/** The persisted current-day note, read-only. */
export function AppointmentNoteReadOnly({ appointmentId, businessDate }) {
  const note = useQuery({
    queryKey: ['appointment-note', appointmentId, businessDate],
    queryFn: () => getAppointmentNote(appointmentId),
    retry: false,
  });
  if (note.isLoading) return <Spinner />;
  if (note.isError || !note.data?.exists) {
    return <p className="rx-row__meta">This appointment note is no longer available.</p>;
  }
  const d = note.data;
  const bcba = formatFirstName(d.authorFirstName);
  return (
    <section className="rx-apptnote rx-apptnote--readonly" aria-label="Appointment Note">
      <dl className="rx-apptnote__facts">
        {bcba && (
          <div className="rx-apptnote__fact"><dt>BCBA</dt><dd>{bcba}</dd></div>
        )}
        {d.clientName && (
          <div className="rx-apptnote__fact rx-apptnote__client"><dt>Client</dt><dd>{d.clientName}</dd></div>
        )}
        <div className="rx-apptnote__fact"><dt>Note</dt><dd className="rx-apptnote__body">{d.note}</dd></div>
      </dl>
    </section>
  );
}

export default AppointmentNotesOverview;
