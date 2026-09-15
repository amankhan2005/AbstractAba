import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchTimesheets, fetchPayPeriods } from '@/api/client';
import { PageHeader, Card, Badge, Icon, DataTable, Select, EmptyState } from '@/ui';

/**
 * Timesheets — a redesigned, filterable ledger. Data is scoped by the backend:
 * an RBT sees only their own timesheets, an operator sees the organization's.
 * Nothing is computed in the UI; totals come from the API.
 */
const STATUS_OPTS = [
  { value: '', label: 'All statuses' }, { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' }, { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' },
];
function hoursFromMinutes(min) { if (min == null) return '—'; const h = Math.floor(min / 60); const m = min % 60; return `${h}h ${m}m`; }

export function TimesheetsRedesign() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const periods = useQuery({ queryKey: ['pay-periods'], queryFn: fetchPayPeriods });
  const query = useQuery({ queryKey: ['timesheets'], queryFn: () => fetchTimesheets({}) });

  const periodLabel = (id) => (periods.data ?? []).find((p) => p._id === id)?.label ?? id;
  const all = query.data ?? [];
  const rows = status ? all.filter((t) => t.status === status) : all;

  const columns = [
    { key: 'period', header: 'Pay period', render: (t) => periodLabel(t.payPeriodId) },
    { key: 'staff', header: 'Staff', render: (t) => <span className="rx-row__meta">{t.staffProfileId}</span> },
    { key: 'time', header: 'Total time', align: 'right', render: (t) => hoursFromMinutes(t.totalMinutes) },
    { key: 'status', header: 'Status', render: (t) => <Badge status={t.status} /> },
    { key: 'actions', header: '', align: 'right', render: (t) => <button className="rx-btn rx-btn--ghost" onClick={(e) => { e.stopPropagation(); navigate(`/payroll/timesheets/${t._id}`); }}>Open</button> },
  ];

  return (
    <>
      <PageHeader title="Timesheets" subtitle="Session-linked time by pay period, with review status." />
      <div style={{ marginBottom: 16, maxWidth: 260 }}>
        <Select value={status} onChange={setStatus} options={STATUS_OPTS} searchable={false} />
      </div>
      <Card title="Timesheets">
        <DataTable query={query} rows={rows} getKey={(t) => t._id} columns={columns}
          empty={<EmptyState icon={Icon.Clock} title="No timesheets yet" body="Timesheets appear here once sessions are captured." />} />
      </Card>
    </>
  );
}

export default TimesheetsRedesign;
