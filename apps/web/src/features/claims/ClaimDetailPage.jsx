import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchClaim, submitClaim, resubmitClaim } from '@/api/client';
import { Card, Button, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast } from '@/components';
import { formatMoney } from './money.js';
import { formatDate, formatDateTime } from '@/lib/format';

/** Claim detail: summary, lines, lifecycle history, and authorized actions. */
export function ClaimDetailPage() {
  const { claimId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(null); // 'submit' | 'resubmit'
  const claim = useQuery({ queryKey: ['claim', claimId], queryFn: () => fetchClaim(claimId) });

  const act = useMutation({
    mutationFn: (kind) => (kind === 'submit' ? submitClaim(claimId) : resubmitClaim(claimId)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['claim', claimId] }); qc.invalidateQueries({ queryKey: ['claims'] }); setConfirm(null); toast.push('Claim updated.'); },
    onError: (err) => { setConfirm(null); toast.push(err?.response?.data?.error?.message ?? 'Could not update claim.', 'negative'); },
  });

  if (claim.isLoading) return <LoadingState label="Loading claim…" />;
  if (claim.isError) return <ErrorState message="Could not load claim." onRetry={() => claim.refetch()} />;
  const c = claim.data;

  const canSubmit = c.status === 'DRAFT';
  const canResubmit = c.status === 'REJECTED' || c.status === 'DENIED';

  return (
    <div className="claims">
      <div className="claims__head">
        <h1 className="page-title">Claim {c.claimNumber}</h1>
        <StatusBadge tone="info">{c.status}</StatusBadge>
      </div>

      <Card>
        <h2 className="card-title">Summary</h2>
        <div className="kv">
          <div><span className="kv__k">Payer</span><span>{c.payerName || '—'}</span></div>
          <div><span className="kv__k">Total units</span><span>{c.totalUnits}</span></div>
          <div><span className="kv__k">Total charge</span><span>{formatMoney(c.totalCharge)}</span></div>
          <div><span className="kv__k">Paid</span><span>{formatMoney(c.paidAmount)}</span></div>
          <div><span className="kv__k">Adjustments</span><span>{formatMoney(c.adjustmentAmount)}</span></div>
          <div><span className="kv__k">Reconciliation</span><span>{c.reconciliationStatus}</span></div>
          {c.rejectionReason ? <div><span className="kv__k">Rejection</span><span>{c.rejectionReason}</span></div> : null}
          {c.denialReason ? <div><span className="kv__k">Denial</span><span>{c.denialReason}</span></div> : null}
        </div>
        <div className="row-actions" style={{ marginTop: '1rem' }}>
          {canSubmit ? <Button onClick={() => setConfirm('submit')} disabled={act.isPending}>Submit claim</Button> : null}
          {canResubmit ? <Button onClick={() => setConfirm('resubmit')} disabled={act.isPending}>Resubmit claim</Button> : null}
        </div>
      </Card>

      <Card>
        <h2 className="card-title">Claim lines</h2>
        {c.lines.length === 0 ? <p className="muted">No lines.</p> : (
          <table className="ui-table">
            <thead><tr><th>Service date</th><th>Service code</th><th>Units</th><th>Charge</th></tr></thead>
            <tbody>
              {c.lines.map((l) => (
                <tr key={l._id}>
                  <td>{formatDate(l.serviceDate)}</td>
                  <td>{l.serviceCode || '—'}</td>
                  <td>{l.units}</td>
                  <td>{formatMoney(l.charge)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h2 className="card-title">Lifecycle history</h2>
        <ol className="timeline">
          {c.history.map((h) => (
            <li key={h._id}>
              <strong>{h.toStatus}</strong>{h.fromStatus ? ` (from ${h.fromStatus})` : ''} — {formatDateTime(h.occurredAt)}
              {h.reason ? <div className="muted">{h.reason}</div> : null}
            </li>
          ))}
        </ol>
      </Card>

      {confirm ? (
        <ConfirmDialog
          title={confirm === 'submit' ? 'Submit claim' : 'Resubmit claim'}
          message={confirm === 'submit'
            ? `Submit claim ${c.claimNumber} to the payer? You won't be able to edit its lines afterward.`
            : `Resubmit claim ${c.claimNumber}? It will re-enter the submitted state.`}
          confirmLabel={confirm === 'submit' ? 'Submit' : 'Resubmit'}
          busy={act.isPending}
          onConfirm={() => act.mutate(confirm)}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}
