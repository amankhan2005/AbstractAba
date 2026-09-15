import { formatDateTime } from '@/lib/format';
import { usePermissions } from '@/auth/permissions';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listSessions } from '@/api/client';
import { Card, LoadingState, ErrorState, EmptyState } from '@/components';

const STATUSES = ['DRAFT', 'SUBMITTED', 'FROZEN'];

/** Session roster, filterable by status. A frozen row is the locked record of record. */
export function SessionsListPage() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canWrite = permissions.includes('sessions.write');

  const [status, setStatus] = useState('');
  const params = { limit: 25 };
  if (status) params.status = status;

  const query = useQuery({ queryKey: ['sessions', params], queryFn: () => listSessions(params) });

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>Sessions</h1>
        {canWrite ? <Link className="ui-button" to="/sessions/new">Start session</Link> : null}
      </div>

      <Card>
        <div className="ui-row">
          <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </Card>

      {query.isLoading ? <LoadingState label="Loading sessions…" /> : null}
      {query.isError ? <ErrorState message="Could not load sessions." onRetry={() => query.refetch()} /> : null}
      {query.isSuccess && query.data.items.length === 0 ? <EmptyState message="No sessions match." /> : null}

      {query.isSuccess && query.data.items.length > 0 ? (
        <Card>
          <table className="table">
            <thead><tr><th>Started</th><th>Status</th><th>Client</th></tr></thead>
            <tbody>
              {query.data.items.map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/sessions/${s.id}`}>{s.startedAt ? formatDateTime(s.startedAt) : '—'}</Link></td>
                  <td>{s.status}</td>
                  <td>{s.clientId}</td>
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
