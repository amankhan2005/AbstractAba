import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { fetchReportsOverview, reportExportUrl } from '@/api/client';
import { PageHeader, Card, KpiCard, Icon, Select, QueryBoundary, Button } from '@/ui';
import { Bars } from '@/ui/charts.jsx';
import { gridVariants } from '@/ui/motion.js';

/**
 * Financial reports — a real-data operations summary. The preset drives a live
 * GET /v1/reports/overview; all money is backend-derived. Export links reuse the
 * existing CSV endpoints where supported. No figure is computed in the UI.
 */
// Values MUST match the backend rangeSchema enum exactly, or /reports/overview 422s.
const PRESET_OPTS = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
];
const EXPORTS = [['revenue', 'Revenue'], ['claims', 'Claims'], ['reconciliation', 'Reconciliation'], ['payroll', 'Payroll']];
const money = (c) => (c == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(c / 100));

export function ReportsRedesign() {
  const [preset, setPreset] = useState('this_month');
  const query = useQuery({ queryKey: ['reports-overview', preset], queryFn: () => fetchReportsOverview({ preset }) });

  return (
    <>
      <PageHeader title="Financial reports" subtitle="Revenue, claims, collections and payroll at a glance — straight from the ledger."
        actions={<div style={{ minWidth: 200 }}><Select value={preset} onChange={setPreset} options={PRESET_OPTS} searchable={false} /></div>} />
      <QueryBoundary query={query}>
        {query.data && (() => {
          const d = query.data;
          return (
            <div className="rx-stack">
              <motion.div className="rx-kpigrid" variants={gridVariants} initial="initial" animate="animate">
                <KpiCard icon={Icon.Wallet} label="Invoiced" value={(d.revenue?.invoiced ?? 0) / 100} format={(n) => money(Math.round(n) * 100)} />
                <KpiCard icon={Icon.Check} label="Collected" value={(d.revenue?.paid ?? 0) / 100} format={(n) => money(Math.round(n) * 100)} />
                <KpiCard icon={Icon.Inbox} label="Outstanding" value={(d.revenue?.outstanding ?? 0) / 100} format={(n) => money(Math.round(n) * 100)} />
                <KpiCard icon={Icon.Trend} label="Collection rate" value={d.revenue?.collectionRate ?? 0} format={(n) => `${Math.round(n)}%`} />
              </motion.div>

              <div className="rx-cols-2">
                <Card title="Collections aging" hint="Outstanding balance by age">
                  <Bars data={{
                    'Current': (d.collections?.aging?.current ?? 0) / 100,
                    '31-60': (d.collections?.aging?.d31_60 ?? 0) / 100,
                    '61-90': (d.collections?.aging?.d61_90 ?? 0) / 100,
                    '90+': (d.collections?.aging?.d90_plus ?? 0) / 100,
                  }} />
                </Card>
                <Card title="Claims">
                  <div className="rx-list">
                    <StatRow label="Total claims" value={d.claims?.total ?? 0} />
                    <StatRow label="Billed" value={money(d.claims?.billedAmount)} />
                    <StatRow label="Paid" value={money(d.claims?.paidAmount)} />
                    <StatRow label="Outstanding" value={money(d.claims?.outstandingAmount)} />
                  </div>
                </Card>
              </div>

              <div className="rx-cols-2">
                <Card title="Payroll">
                  <div className="rx-list">
                    <StatRow label="Pay periods" value={d.payroll?.payPeriods ?? 0} />
                    <StatRow label="Finalized runs" value={d.payroll?.finalizedRuns ?? 0} />
                    <StatRow label="Finalized cost" value={money(d.payroll?.totalFinalizedCost)} />
                  </div>
                </Card>
                <Card title="Reconciliation">
                  <div className="rx-list">
                    <StatRow label="Reconciled" value={d.reconciliation?.reconciled ?? 0} />
                    <StatRow label="Partial" value={d.reconciliation?.partial ?? 0} />
                    <StatRow label="Discrepancies" value={d.reconciliation?.discrepancy ?? 0} />
                    <StatRow label="Outstanding" value={money(d.reconciliation?.outstandingAmount)} />
                  </div>
                </Card>
              </div>

              <Card title="Export" hint="Download the underlying detail as CSV">
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {EXPORTS.map(([kind, label]) => (
                    <a key={kind} className="rx-btn rx-btn--ghost" href={reportExportUrl(kind, { preset })} download>
                      <Icon.Doc size={16} /> {label}
                    </a>
                  ))}
                </div>
              </Card>
            </div>
          );
        })()}
      </QueryBoundary>
    </>
  );
}

function StatRow({ label, value }) {
  return <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">{label}</div></div><strong>{value}</strong></div>;
}

export default ReportsRedesign;
