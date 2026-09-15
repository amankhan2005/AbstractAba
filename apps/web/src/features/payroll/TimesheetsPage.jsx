import { useQuery } from '@tanstack/react-query';
import { fetchTimesheets, fetchPayPeriods } from '@/api/client';
import { Card, StatusBadge, LoadingState, ErrorState, EmptyState } from '@/components';
import { formatMinutes } from './money.js';

function tsTone(status) {
  return { APPROVED: 'success', SUBMITTED: 'info', REJECTED: 'danger', DRAFT: 'neutral' }[status] ?? 'neutral';
}

/** Company timesheets list. Tenant-scoped; the server serves only this org. */
export function TimesheetsPage() {
  const periods = useQuery({ queryKey: ['pay-periods'], queryFn: fetchPayPeriods });
  const timesheets = useQuery({ queryKey: ['timesheets'], queryFn: () => fetchTimesheets({}) });
  const periodLabel = (id) => periods.data?.find((p) => p._id === id)?.label ?? id;

  return (
    <div className="payroll">
      <h1 className="page-title">Timesheets</h1>
      <Card>
        {timesheets.isLoading ? <LoadingState label="Loading timesheets…" />
          : timesheets.isError ? <ErrorState message="Could not load timesheets." onRetry={() => timesheets.refetch()} />
          : timesheets.data.length === 0 ? <EmptyState message="No timesheets yet." />
          : (
            <table className="ui-table">
              <thead><tr><th>Staff</th><th>Pay period</th><th>Total time</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {timesheets.data.map((t) => (
                  <tr key={t._id}>
                    <td className="muted">{t.staffProfileId}</td>
                    <td>{periodLabel(t.payPeriodId)}</td>
                    <td>{formatMinutes(t.totalMinutes)}</td>
                    <td><StatusBadge tone={tsTone(t.status)}>{t.status}</StatusBadge></td>
                    <td><a className="ui-link" href={`/payroll/timesheets/${t._id}`}>Open</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
    </div>
  );
}
