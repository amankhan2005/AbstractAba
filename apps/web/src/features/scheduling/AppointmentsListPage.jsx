import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listAppointments } from '@/api/client';
import { Card, LoadingState, ErrorState, EmptyState } from '@/components';
import { formatDateTime } from '@/lib/format';

const STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

/** A flat, filterable list of appointments. */
export function AppointmentsListPage() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canWrite = permissions.includes('scheduling.write');

  const [status, setStatus] = useState('');
  const params = { limit: 25 };
  if (status) params.status = status;

  const query = useQuery({ queryKey: ['appointments', 'list', params], queryFn: () => listAppointments(params) });

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>Appointments</h1>
        <div className="ui-row">
          <Link className="ui-button ui-button--ghost" to="/scheduling">Calendar</Link>
          {canWrite ? <Link className="ui-button" to="/scheduling">New appointment</Link> : null}
        </div>
      </div>

      <Card>
        <div className="ui-row">
          <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </Card>

      {query.isLoading ? <LoadingState label="Loading appointments…" /> : null}
      {query.isError ? <ErrorState message="Could not load appointments." onRetry={() => query.refetch()} /> : null}
      {query.isSuccess && query.data.items.length === 0 ? <EmptyState message="No appointments match." /> : null}

      {query.isSuccess && query.data.items.length > 0 ? (
        <Card>
          <table className="table">
            <thead><tr><th>Start (UTC)</th><th>End (UTC)</th><th>Units</th><th>Status</th></tr></thead>
            <tbody>
              {query.data.items.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/scheduling/appointments/${a.id}`}>{formatDateTime(a.startAt)}</Link></td>
                  <td>{formatDateTime(a.endAt)}</td>
                  <td>{a.units}</td>
                  <td>{a.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.data.meta?.nextCursor ? <p className="muted">More results available — narrow with a filter.</p> : null}
        </Card>
      ) : null}
    </div>
  );
}
