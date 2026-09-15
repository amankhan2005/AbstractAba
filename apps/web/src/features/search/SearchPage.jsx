import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { globalSearch } from '@/api/client';
import { Card, StatusBadge, LoadingState, ErrorState, EmptyState } from '@/components';

const TYPE_LABELS = { clients: 'Clients', staff: 'Staff', authorizations: 'Authorizations', documents: 'Documents', claims: 'Claims' };
const READ_PERMS = { clients: 'clients.read', staff: 'staff.read', authorizations: 'scheduling.read', documents: 'documents.read', claims: 'claims.read' };

// Where a given result type links in the app (best-effort; falls back to plain text).
function linkFor(item) {
  switch (item.type) {
    case 'client': return `/clients/${item.id}`;
    case 'document': return `/documents/${item.id}`;
    default: return null;
  }
}

/**
 * Global search across the entities the user is authorized to read. Read-only;
 * the server authorizes each entity and scopes to the tenant. Type chips let the
 * user narrow to one entity; results are grouped by type with counts.
 */
export function SearchPage() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const available = Object.keys(TYPE_LABELS).filter((t) => permissions.includes(READ_PERMS[t]));

  const [term, setTerm] = useState('');
  const [activeType, setActiveType] = useState(null);
  const [submitted, setSubmitted] = useState('');

  const query = useQuery({
    queryKey: ['search', submitted, activeType],
    queryFn: () => globalSearch({ q: submitted, ...(activeType ? { types: activeType } : {}) }),
    enabled: submitted.trim().length > 0,
  });

  const onSubmit = (e) => { e.preventDefault(); setSubmitted(term.trim()); };

  return (
    <div className="ui-stack">
      <h1>Search</h1>

      <Card>
        <form onSubmit={onSubmit}>
          <div className="ui-row" style={{ gap: '0.5rem' }}>
            <input
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search clients, staff, authorizations, documents, claims…"
              aria-label="Search term"
              style={{ flex: 1 }}
            />
          </div>
          {available.length > 1 ? (
            <div className="ui-row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              <button type="button" className={`chip${activeType === null ? ' chip--active' : ''}`} onClick={() => setActiveType(null)}>All</button>
              {available.map((t) => (
                <button key={t} type="button" className={`chip${activeType === t ? ' chip--active' : ''}`} onClick={() => setActiveType(t)}>{TYPE_LABELS[t]}</button>
              ))}
            </div>
          ) : null}
        </form>
      </Card>

      {submitted.trim().length === 0 ? (
        <EmptyState message="Enter a term to search across the records you can access." />
      ) : query.isLoading ? (
        <LoadingState label="Searching…" />
      ) : query.isError ? (
        <ErrorState message="Search failed." onRetry={() => query.refetch()} />
      ) : (query.data?.totalCount ?? 0) === 0 ? (
        <EmptyState message={`No results for “${submitted}”.`} />
      ) : (
        <div className="ui-stack">
          <p className="muted">{query.data.totalCount} result{query.data.totalCount === 1 ? '' : 's'}</p>
          {query.data.groups.filter((g) => g.count > 0).map((group) => (
            <Card key={group.type}>
              <div className="ui-row" style={{ justifyContent: 'space-between' }}>
                <h2>{TYPE_LABELS[group.type] ?? group.type}</h2>
                <span className="muted">{group.count}</span>
              </div>
              <ul className="ui-list">
                {group.items.map((item) => {
                  const to = linkFor(item);
                  const label = (
                    <span className="ui-row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                      <strong>{item.label || '(untitled)'}</strong>
                      {item.status ? <StatusBadge status={item.status} /> : null}
                      {item.clientNumber ? <span className="muted">#{item.clientNumber}</span> : null}
                      {item.payerName ? <span className="muted">{item.payerName}</span> : null}
                      {item.discipline ? <span className="muted">{item.discipline}</span> : null}
                    </span>
                  );
                  return <li key={item.id}>{to ? <Link to={to}>{label}</Link> : label}</li>;
                })}
              </ul>
              {group.hasMore ? <p className="muted">More results available — refine your search to narrow them.</p> : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
