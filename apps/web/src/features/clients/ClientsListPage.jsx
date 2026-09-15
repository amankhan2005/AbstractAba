import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { formatFullName } from '@/lib/format';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listClients } from '@/api/client';
import { Button, Card, LoadingState, ErrorState, EmptyState } from '@/components';

const STATUSES = ['REFERRED', 'INTAKE', 'ACTIVE', 'ON_HOLD', 'DISCHARGED', 'ARCHIVED'];

/**
 * The clients roster: searchable, filterable by status, paginated by the API's
 * opaque cursor. The "New client" action is shown only to a principal that can
 * create — the server enforces the same permission regardless.
 */
export function ClientsListPage() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canCreate = permissions.includes('clients.create');

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const params = { limit: 25 };
  if (search.trim()) params.search = search.trim();
  if (status) params.status = status;

  const query = useQuery({
    queryKey: ['clients', params],
    queryFn: () => listClients(params),
  });

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>Clients</h1>
        {canCreate ? <Link className="ui-button" to="/clients/new">New client</Link> : null}
      </div>

      <Card>
        <div className="ui-row">
          <input
            className="input"
            placeholder="Search name or number"
            value={search}
            onChange={(e) => { setSearch(e.target.value); }}
            aria-label="Search clients"
          />
          <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </Card>

      {query.isLoading ? <LoadingState label="Loading clients…" /> : null}
      {query.isError ? <ErrorState message="Could not load clients." onRetry={() => query.refetch()} /> : null}
      {query.isSuccess && query.data.items.length === 0 ? <EmptyState message="No clients match." /> : null}

      {query.isSuccess && query.data.items.length > 0 ? (
        <Card>
          <table className="table">
            <thead>
              <tr><th>Client #</th><th>Name</th><th>Status</th></tr>
            </thead>
            <tbody>
              {query.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.clientNumber}</td>
                  <td><Link to={`/clients/${c.id}`}>{formatFullName(c)}</Link></td>
                  <td>{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.data.meta?.nextCursor ? (
            <p className="muted">More results available — refine your search to narrow them.</p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
