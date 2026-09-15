import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listDocuments } from '@/api/client';
import { Card, LoadingState, ErrorState, EmptyState } from '@/components';

const STATUSES = ['DRAFT', 'FINALIZED', 'ARCHIVED'];
const TYPES = ['ASSESSMENT', 'CONSENT', 'TREATMENT_REPORT', 'AUTHORIZATION_LETTER', 'EVALUATION', 'PROGRESS_NOTE', 'CORRESPONDENCE', 'OTHER'];

/** Clinical documents roster, filterable by status and type. */
export function DocumentsListPage() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canWrite = permissions.includes('documents.write');

  const [status, setStatus] = useState('');
  const [documentType, setDocumentType] = useState('');
  const params = { limit: 25 };
  if (status) params.status = status;
  if (documentType) params.documentType = documentType;

  const query = useQuery({ queryKey: ['documents', params], queryFn: () => listDocuments(params) });

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>Clinical documents</h1>
        {canWrite ? <Link className="ui-button" to="/documents/new">New document</Link> : null}
      </div>

      <Card>
        <div className="ui-row">
          <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input" value={documentType} onChange={(e) => { setDocumentType(e.target.value); }} aria-label="Filter by type">
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </Card>

      {query.isLoading ? <LoadingState label="Loading documents…" /> : null}
      {query.isError ? <ErrorState message="Could not load documents." onRetry={() => query.refetch()} /> : null}
      {query.isSuccess && query.data.items.length === 0 ? <EmptyState message="No documents match." /> : null}

      {query.isSuccess && query.data.items.length > 0 ? (
        <Card>
          <table className="table">
            <thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              {query.data.items.map((d) => (
                <tr key={d.id}>
                  <td><Link to={`/documents/${d.id}`}>{d.title}</Link></td>
                  <td>{d.documentType}</td>
                  <td>{d.status}</td>
                  <td>{d.documentDate ? String(d.documentDate).slice(0, 10) : '—'}</td>
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
