import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchReconciliationRecords, fetchReconciliationQueue, transitionReconciliation } from '@/api/client';
import { Card, Button, StatusBadge, LoadingState, ErrorState, EmptyState, ConfirmDialog, useToast } from '@/components';
import { formatMoney } from './money.js';

function tone(s) {
  return { RECONCILED: 'success', RESOLVED: 'success', PARTIAL: 'warning', REVIEWING: 'info', DISCREPANCY: 'danger', UNRECONCILED: 'neutral' }[s] ?? 'neutral';
}

/** Reconciliation workspace: records, discrepancy/unmatched queue, and workflow. */
export function ReconciliationPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(null); // { rec, target }
  const records = useQuery({ queryKey: ['recon-records'], queryFn: () => fetchReconciliationRecords({}) });
  const queue = useQuery({ queryKey: ['recon-queue'], queryFn: fetchReconciliationQueue });

  const transition = useMutation({
    mutationFn: ({ id, target }) => transitionReconciliation(id, target),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recon-records'] }); qc.invalidateQueries({ queryKey: ['recon-queue'] }); setConfirm(null); toast.push('Reconciliation updated.'); },
    onError: (err) => { setConfirm(null); toast.push(err?.response?.data?.error?.message ?? 'Could not update reconciliation.', 'negative'); },
  });

  return (
    <div className="reports">
      <h1 className="page-title">Reconciliation</h1>

      <Card>
        <h2 className="card-title">Needs attention</h2>
        {queue.isLoading ? <LoadingState label="Loading queue…" />
          : queue.isError ? <ErrorState message="Could not load queue." onRetry={() => queue.refetch()} />
          : (queue.data.eraUnresolved.length === 0 && queue.data.discrepancies.length === 0) ? <EmptyState message="Nothing needs attention. All settled." />
          : (
            <table className="ui-table">
              <thead><tr><th>Type</th><th>Reference</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {queue.data.eraUnresolved.map((q) => (
                  <tr key={q._id}><td>ERA remittance</td><td>{q.reference || '—'}</td><td>{formatMoney(q.amount)}</td><td><StatusBadge tone="danger">{q.matchStatus}</StatusBadge></td></tr>
                ))}
                {queue.data.discrepancies.map((q) => (
                  <tr key={q._id}><td>{q.source} discrepancy</td><td>{q.claimId || q.invoiceId || '—'}</td><td>{formatMoney(q.amount)}</td><td><StatusBadge tone="danger">{q.reason || 'DISCREPANCY'}</StatusBadge></td></tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      <Card>
        <h2 className="card-title">Reconciliation records</h2>
        {records.isLoading ? <LoadingState label="Loading records…" />
          : records.isError ? <ErrorState message="Could not load records." onRetry={() => records.refetch()} />
          : records.data.length === 0 ? <EmptyState message="No reconciliation records yet." />
          : (
            <table className="ui-table">
              <thead><tr><th>Source</th><th>Billed</th><th>Paid</th><th>Adjustments</th><th>Remaining</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {records.data.map((r) => (
                  <tr key={r._id}>
                    <td>{r.source}</td>
                    <td>{formatMoney(r.billedAmount)}</td>
                    <td>{formatMoney(r.paidAmount)}</td>
                    <td>{formatMoney(r.adjustmentAmount)}</td>
                    <td>{formatMoney(r.remainingAmount)}</td>
                    <td><StatusBadge tone={tone(r.status)}>{r.status}</StatusBadge></td>
                    <td>
                      <div className="row-actions">
                        {['UNRECONCILED', 'PARTIAL', 'REVIEWING'].includes(r.status) ? <Button variant="ghost" onClick={() => setConfirm({ rec: r, target: 'RECONCILED' })}>Mark reconciled</Button> : null}
                        {r.status === 'DISCREPANCY' ? <Button variant="ghost" onClick={() => setConfirm({ rec: r, target: 'RESOLVED' })}>Resolve</Button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {confirm ? (
        <ConfirmDialog
          title={confirm.target === 'RESOLVED' ? 'Resolve discrepancy' : 'Mark reconciled'}
          message={confirm.target === 'RESOLVED'
            ? 'Mark this discrepancy as resolved? This is a terminal state and records the resolution.'
            : 'Mark this record as fully reconciled? This is a terminal state.'}
          confirmLabel={confirm.target === 'RESOLVED' ? 'Resolve' : 'Mark reconciled'}
          busy={transition.isPending}
          onConfirm={() => transition.mutate({ id: confirm.rec._id, target: confirm.target })}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}
