import { useQuery } from '@tanstack/react-query';
import { fetchMyInvoices, fetchMyPayments, fetchMyBalance } from '@/api/client';
import { Card, StatusBadge, LoadingState, ErrorState, EmptyState } from '@/components';
import { formatMoney } from './money.js';
import { formatDate } from '@/lib/format';

// Subscription now lives on the dedicated /subscription page (spec §1). Billing
// is insurance/clinical billing only: balance, invoices, payments (and claims).
// countdownText is re-exported for backward compatibility with existing tests.
export { countdownText } from './subscription.jsx';

function invoiceTone(status) {
  return { PAID: 'success', OPEN: 'info', VOID: 'neutral', UNCOLLECTIBLE: 'danger', DRAFT: 'warning' }[status] ?? 'neutral';
}

/**
 * Company billing overview. Read-only, tenant-scoped — every request is served
 * from the caller's own organization by the backend, so no company can see
 * another's data. All money comes pre-computed from the server.
 */
export function BillingPage() {
  const balance = useQuery({ queryKey: ['my-balance'], queryFn: fetchMyBalance });
  const invoices = useQuery({ queryKey: ['my-invoices'], queryFn: fetchMyInvoices });
  const payments = useQuery({ queryKey: ['my-payments'], queryFn: fetchMyPayments });

  return (
    <div className="billing">
      <h1 className="page-title">Billing</h1>

      <div className="billing__notice" role="note">
        Payments are processed manually. Please contact your organization's billing administrator for payment instructions.
      </div>

      <div className="billing__cards">
        <Card>
          <h2 className="card-title">Outstanding balance</h2>
          {balance.isLoading ? <LoadingState label="Loading…" />
            : balance.isError ? <ErrorState message="Could not load balance." onRetry={() => balance.refetch()} />
            : <p className="billing__balance">{formatMoney(balance.data.outstanding)}</p>}
          {balance.data ? <p className="muted">{balance.data.openInvoiceCount} open invoice(s)</p> : null}
        </Card>
      </div>

      <Card>
        <h2 className="card-title">Invoices</h2>
        {invoices.isLoading ? <LoadingState label="Loading invoices…" />
          : invoices.isError ? <ErrorState message="Could not load invoices." onRetry={() => invoices.refetch()} />
          : invoices.data.length === 0 ? <EmptyState message="No invoices yet." />
          : (
            <table className="ui-table">
              <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th>Total</th><th>Paid</th><th>Remaining</th><th>Status</th></tr></thead>
              <tbody>
                {invoices.data.map((i) => (
                  <tr key={i._id}>
                    <td>{i.invoiceNumber}</td>
                    <td>{i.issuedAt ? formatDate(i.issuedAt) : '—'}</td>
                    <td>{i.dueDate ? formatDate(i.dueDate) : '—'}</td>
                    <td>{formatMoney(i.total, i.currency)}</td>
                    <td>{formatMoney(i.amountPaid, i.currency)}</td>
                    <td>{formatMoney(i.amountDue, i.currency)}</td>
                    <td><StatusBadge tone={invoiceTone(i.status)}>{i.status}</StatusBadge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      <Card>
        <h2 className="card-title">Payment history</h2>
        {payments.isLoading ? <LoadingState label="Loading payments…" />
          : payments.isError ? <ErrorState message="Could not load payments." onRetry={() => payments.refetch()} />
          : payments.data.length === 0 ? <EmptyState message="No payments yet." />
          : (
            <table className="ui-table">
              <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead>
              <tbody>
                {payments.data.map((p) => (
                  <tr key={p._id}>
                    <td>{p.paidAt ? formatDate(p.paidAt) : '—'}</td>
                    <td>{formatMoney(p.amount, p.currency)}</td>
                    <td>{p.paymentMethod}</td>
                    <td><StatusBadge tone={p.status === 'SUCCEEDED' ? 'success' : p.status === 'REFUNDED' ? 'neutral' : 'warning'}>{p.status}</StatusBadge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
    </div>
  );
}
