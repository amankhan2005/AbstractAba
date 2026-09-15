import { formatDate } from '@/lib/format';
import { usePermissions } from '@/auth/permissions';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listAppointments } from '@/api/client';
import { Button, Card, LoadingState, ErrorState } from '@/components';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Start of the week (Sunday, UTC) containing `date`. */
function weekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}
function fmtTime(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * A week calendar of appointments: seven day columns, each listing that day's
 * appointments by start time, with previous / today / next navigation. Times are
 * shown in UTC to match how the API stores them. "New appointment" is shown to
 * principals who can book.
 */
export function SchedulingCalendarPage() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canWrite = permissions.includes('scheduling.write');

  const [anchor, setAnchor] = useState(() => weekStart(new Date()));
  const from = anchor.toISOString();
  const to = new Date(anchor.getTime() + 7 * DAY_MS).toISOString();

  const query = useQuery({
    queryKey: ['appointments', 'week', from],
    queryFn: () => listAppointments({ from, to, limit: 100 }),
  });

  const days = Array.from({ length: 7 }, (_, i) => new Date(anchor.getTime() + i * DAY_MS));
  const todayKey = new Date().toISOString().slice(0, 10);
  const byDay = (day) => {
    const key = day.toISOString().slice(0, 10);
    return (query.data?.items ?? [])
      .filter((a) => new Date(a.startAt).toISOString().slice(0, 10) === key)
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  };

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>Scheduling</h1>
        <div className="ui-row">
          <Link className="ui-button ui-button--ghost" to="/scheduling/appointments">List</Link>
          <Link className="ui-button ui-button--ghost" to="/scheduling/authorizations">Authorizations</Link>
          {permissions.includes('scheduling.manage') ? <Link className="ui-button ui-button--ghost" to="/scheduling/availability">Availability</Link> : null}
          {canWrite ? <Link className="ui-button" to="/scheduling">New appointment</Link> : null}
        </div>
      </div>

      <Card>
        <div className="cal-toolbar">
          <Button variant="ghost" onClick={() => setAnchor((a) => new Date(a.getTime() - 7 * DAY_MS))}>← Prev</Button>
          <Button variant="ghost" onClick={() => setAnchor(weekStart(new Date()))}>Today</Button>
          <Button variant="ghost" onClick={() => setAnchor((a) => new Date(a.getTime() + 7 * DAY_MS))}>Next →</Button>
          <span className="muted">Week of {formatDate(anchor.toISOString().slice(0, 10))}</span>
        </div>
      </Card>

      {query.isLoading ? <LoadingState label="Loading week…" /> : null}
      {query.isError ? <ErrorState message="Could not load appointments." onRetry={() => query.refetch()} /> : null}

      {query.isSuccess ? (
        <div className="cal-grid">
          {days.map((day) => {
            const key = day.toISOString().slice(0, 10);
            const isToday = key === todayKey;
            return (
              <div key={key} className={isToday ? 'cal-day cal-day__today' : 'cal-day'}>
                <div className="cal-day__label">{DAY_LABELS[day.getUTCDay()]} {day.getUTCDate()}</div>
                {byDay(day).map((a) => (
                  <Link
                    key={a.id}
                    to={`/scheduling/appointments/${a.id}`}
                    className={a.status === 'CANCELLED' ? 'cal-event cal-event--cancelled' : 'cal-event'}
                  >
                    {fmtTime(a.startAt)} · {a.status}
                  </Link>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
