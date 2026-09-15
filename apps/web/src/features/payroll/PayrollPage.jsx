import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchPayrollRuns, fetchPayPeriods, generatePayrollRun, transitionPayrollRun } from '@/api/client';
import { Card, Button, StatusBadge, LoadingState, ErrorState, EmptyState, ConfirmDialog , useToast } from '@/components';
import { formatMoney } from './money.js';

function runTone(status) {
  return { FINALIZED: 'success', APPROVED: 'info', DRAFT: 'neutral' }[status] ?? 'neutral';
}

/**
 * Company payroll. Runs are generated from APPROVED timesheets (server computes
 * all amounts). A run moves DRAFT -> APPROVED -> FINALIZED; finalize is
 * irreversible and behind a confirmation dialog. No amounts are computed here.
 */
export function PayrollPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const periods = useQuery({ queryKey: ['pay-periods'], queryFn: fetchPayPeriods });
  const runs = useQuery({ queryKey: ['payroll-runs'], queryFn: () => fetchPayrollRuns({}) });
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const [confirm, setConfirm] = useState(null); // { run, target }
  const periodLabel = (id) => periods.data?.find((p) => p._id === id)?.label ?? id;

  const generate = useMutation({
    mutationFn: () => generatePayrollRun(selectedPeriod),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); toast.push('Payroll run generated.'); },
  });
  const transition = useMutation({
    mutationFn: ({ id, target }) => transitionPayrollRun(id, target),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payroll-runs'] }); setConfirm(null); toast.push('Payroll run updated.'); },
    onError: (err) => { setConfirm(null); toast.push(err?.response?.data?.error?.message ?? 'Could not update payroll run.', 'negative'); },
  });

  return (
    <div className="payroll">
      <h1 className="page-title">Payroll</h1>

      <Card>
        <h2 className="card-title">Generate a payroll run</h2>
        <p className="muted">Runs are calculated on the server from approved timesheets and effective pay rates.</p>
        <div className="payroll__gen">
          <select value={selectedPeriod} onChange={(e) => setSelectedPeriod(e.target.value)} aria-label="Pay period">
            <option value="">Select a pay period…</option>
            {(periods.data ?? []).map((p) => <option key={p._id} value={p._id}>{p.label}</option>)}
          </select>
          <Button onClick={() => generate.mutate()} disabled={!selectedPeriod || generate.isPending}>
            {generate.isPending ? 'Generating…' : 'Generate run'}
          </Button>
        </div>
        {generate.isError ? <p className="form-error">{generate.error?.response?.data?.error?.message ?? 'Could not generate run.'}</p> : null}
      </Card>

      <Card>
        <h2 className="card-title">Payroll runs</h2>
        {runs.isLoading ? <LoadingState label="Loading runs…" />
          : runs.isError ? <ErrorState message="Could not load payroll runs." onRetry={() => runs.refetch()} />
          : runs.data.length === 0 ? <EmptyState message="No payroll runs yet." />
          : (
            <table className="ui-table">
              <thead><tr><th>Pay period</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {runs.data.map((run) => (
                  <tr key={run._id}>
                    <td>{periodLabel(run.payPeriodId)}</td>
                    <td>{formatMoney(run.totalAmount, run.currency)}</td>
                    <td><StatusBadge tone={runTone(run.status)}>{run.status}</StatusBadge></td>
                    <td>
                      <div className="row-actions">
                        <a className="ui-link" href={`/payroll/runs/${run._id}`}>View</a>
                        {run.status === 'DRAFT' ? <Button variant="ghost" onClick={() => setConfirm({ run, target: 'APPROVED' })}>Approve</Button> : null}
                        {run.status === 'APPROVED' ? <Button variant="ghost" onClick={() => setConfirm({ run, target: 'FINALIZED' })}>Finalize</Button> : null}
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
          title={confirm.target === 'FINALIZED' ? 'Finalize payroll run' : 'Approve payroll run'}
          message={confirm.target === 'FINALIZED'
            ? `Finalizing locks this payroll run for ${periodLabel(confirm.run.payPeriodId)} permanently. It cannot be edited or regenerated afterward.`
            : `Approve this payroll run for ${periodLabel(confirm.run.payPeriodId)}? You can still revert to draft before finalizing.`}
          confirmLabel={confirm.target === 'FINALIZED' ? 'Finalize' : 'Approve'}
          tone={confirm.target === 'FINALIZED' ? 'danger' : 'accent'}
          busy={transition.isPending}
          onConfirm={() => transition.mutate({ id: confirm.run._id, target: confirm.target })}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}
