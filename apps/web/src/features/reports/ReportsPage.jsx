import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchReportsOverview, downloadReportCsv, downloadReportXlsx } from '@/api/client';
import { Card, Button, LoadingState, ErrorState } from '@/components';
import { formatMoney } from './money.js';

const PRESETS = [
  ['this_month', 'This month'], ['last_month', 'Last month'],
  ['this_quarter', 'This quarter'], ['this_week', 'This week'], ['today', 'Today'],
];
const EXPORTS = [['revenue', 'Revenue'], ['claims', 'Claims'], ['reconciliation', 'Reconciliation'], ['payroll', 'Payroll']];

/**
 * Company financial reporting. All figures are aggregated and computed on the
 * server for the selected date range; this page only displays and offers CSV
 * export (downloaded via the authenticated client, not a raw link).
 */
export function ReportsPage() {
  const [preset, setPreset] = useState('this_month');
  const [exporting, setExporting] = useState(null);
  const overview = useQuery({ queryKey: ['reports-overview', preset], queryFn: () => fetchReportsOverview({ preset }) });

  async function exportFile(kind, format) {
    const tag = `${kind}:${format}`;
    setExporting(tag);
    try {
      const blob = format === 'xlsx' ? await downloadReportXlsx(kind, { preset }) : await downloadReportCsv(kind, { preset });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${kind}-report.${format === 'xlsx' ? 'xlsx' : 'csv'}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } finally { setExporting(null); }
  }

  const d = overview.data;
  return (
    <div className="reports">
      <div className="reports__head">
        <h1 className="page-title">Financial reports</h1>
        <label className="field field--inline">
          <span>Period</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>

      {overview.isLoading ? <LoadingState label="Loading reports…" />
        : overview.isError ? <ErrorState message="Could not load reports." onRetry={() => overview.refetch()} />
        : (
          <>
            <div className="reports__grid">
              <Card><h2 className="card-title">Revenue</h2>
                <dl className="stat-list">
                  <div><dt>Invoiced</dt><dd>{formatMoney(d.revenue.invoiced)}</dd></div>
                  <div><dt>Collected</dt><dd>{formatMoney(d.revenue.paid)}</dd></div>
                  <div><dt>Outstanding</dt><dd>{formatMoney(d.revenue.outstanding)}</dd></div>
                  <div><dt>Collection rate</dt><dd>{d.revenue.collectionRate}%</dd></div>
                </dl>
              </Card>
              <Card><h2 className="card-title">Claims</h2>
                <dl className="stat-list">
                  <div><dt>Total</dt><dd>{d.claims.total}</dd></div>
                  <div><dt>Billed</dt><dd>{formatMoney(d.claims.billedAmount)}</dd></div>
                  <div><dt>Paid</dt><dd>{formatMoney(d.claims.paidAmount)}</dd></div>
                  <div><dt>Outstanding</dt><dd>{formatMoney(d.claims.outstandingAmount)}</dd></div>
                </dl>
              </Card>
              <Card><h2 className="card-title">Collections aging</h2>
                <dl className="stat-list">
                  <div><dt>Current (0–30)</dt><dd>{formatMoney(d.collections.aging.current)}</dd></div>
                  <div><dt>31–60</dt><dd>{formatMoney(d.collections.aging.d31_60)}</dd></div>
                  <div><dt>61–90</dt><dd>{formatMoney(d.collections.aging.d61_90)}</dd></div>
                  <div><dt>90+</dt><dd>{formatMoney(d.collections.aging.d90_plus)}</dd></div>
                </dl>
              </Card>
              <Card><h2 className="card-title">Payroll</h2>
                <dl className="stat-list">
                  <div><dt>Pay periods</dt><dd>{d.payroll.payPeriods}</dd></div>
                  <div><dt>Finalized runs</dt><dd>{d.payroll.finalizedRuns}</dd></div>
                  <div><dt>Finalized cost</dt><dd>{formatMoney(d.payroll.totalFinalizedCost)}</dd></div>
                </dl>
              </Card>
              <Card><h2 className="card-title">Reconciliation</h2>
                <dl className="stat-list">
                  <div><dt>Reconciled</dt><dd>{d.reconciliation.reconciled}</dd></div>
                  <div><dt>Partial</dt><dd>{d.reconciliation.partial}</dd></div>
                  <div><dt>Discrepancies</dt><dd>{d.reconciliation.discrepancy}</dd></div>
                  <div><dt>Outstanding</dt><dd>{formatMoney(d.reconciliation.outstandingAmount)}</dd></div>
                </dl>
              </Card>
            </div>

            <Card>
              <h2 className="card-title">Export</h2>
              <div className="row-actions" style={{ display: 'grid', gap: 8 }}>
                {EXPORTS.map(([kind, label]) => (
                  <div key={kind} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ minWidth: 130 }}>{label}</span>
                    <Button variant="primary" onClick={() => exportFile(kind, 'xlsx')} disabled={exporting === `${kind}:xlsx`}>
                      {exporting === `${kind}:xlsx` ? 'Exporting…' : 'Excel (.xlsx)'}
                    </Button>
                    <Button variant="ghost" onClick={() => exportFile(kind, 'csv')} disabled={exporting === `${kind}:csv`}>
                      {exporting === `${kind}:csv` ? 'Exporting…' : 'CSV'}
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
    </div>
  );
}
