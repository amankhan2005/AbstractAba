import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchClaims } from '@/api/client';
import { Card, StatusBadge, LoadingState, ErrorState, EmptyState } from '@/components';
import { formatMoney } from './money.js';
import { formatDate } from '@/lib/format';

function claimTone(status) {
  return {
    PAID: 'success', ACCEPTED: 'info', SUBMITTED: 'info', RESUBMITTED: 'info',
    REJECTED: 'danger', DENIED: 'danger', DRAFT: 'neutral', CLOSED: 'neutral',
  }[status] ?? 'neutral';
}

const STATUSES = ['', 'DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'DENIED', 'PAID', 'CLOSED'];

/** Company claims list with a status filter. Tenant-scoped by the server. */
export function ClaimsPage() {
  const [status, setStatus] = useState('');
  const claims = useQuery({ queryKey: ['claims', status], queryFn: () => fetchClaims(status ? { status } : {}) });

  return (
    <div className="claims">
      <h1 className="page-title">Claims</h1>
      <Card>
        <div className="claims__toolbar">
          <label className="field field--inline">
            <span>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s || 'All'}</option>)}
            </select>
          </label>
        </div>
        {claims.isLoading ? <LoadingState label="Loading claims…" />
          : claims.isError ? <ErrorState message="Could not load claims." onRetry={() => claims.refetch()} />
          : claims.data.length === 0 ? <EmptyState message="No claims yet." />
          : (
            <table className="ui-table">
              <thead><tr><th>Claim #</th><th>Payer</th><th>Service period</th><th>Units</th><th>Charge</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {claims.data.map((c) => (
                  <tr key={c._id}>
                    <td>{c.claimNumber}</td>
                    <td>{c.payerName || '—'}</td>
                    <td>{c.servicePeriodStart ? formatDate(c.servicePeriodStart) : '—'} – {c.servicePeriodEnd ? formatDate(c.servicePeriodEnd) : '—'}</td>
                    <td>{c.totalUnits}</td>
                    <td>{formatMoney(c.totalCharge)}</td>
                    <td><StatusBadge tone={claimTone(c.status)}>{c.status}</StatusBadge></td>
                    <td><a className="ui-link" href={`/claims/${c._id}`}>View</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
    </div>
  );
}
