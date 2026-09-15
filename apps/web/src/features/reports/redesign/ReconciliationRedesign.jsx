import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { fetchReconciliationRecords, fetchReconciliationQueue, transitionReconciliation } from '@/api/client';
import { useToast } from '@/components';
import { PageHeader, Card, KpiCard, Badge, Icon, DataTable, Button, Confirm, EmptyState, Spinner, ErrorState } from '@/ui';
import { gridVariants } from '@/ui/motion.js';

/**
 * Reconciliation — the exception workspace. A summary band, an attention queue
 * (unresolved ERA + discrepancies) and the full records table, all from real
 * endpoints. Transitions run through a designed confirm dialog.
 */
const money = (c) => (c == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(c / 100));

export function ReconciliationRedesign() {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(null);

  const records = useQuery({ queryKey: ['recon-records'], queryFn: () => fetchReconciliationRecords({}) });
  const queue = useQuery({ queryKey: ['recon-queue'], queryFn: fetchReconciliationQueue });

  const transition = useMutation({
    mutationFn: ({ record, target }) => transitionReconciliation(record._id ?? record.id, target),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['recon-records'] }); qc.invalidateQueries({ queryKey: ['recon-queue'] }); setConfirm(null); toast.push('Reconciliation updated.'); },
    onError: (e) => { setConfirm(null); toast.push(e?.response?.data?.error?.message ?? 'Could not update.', 'negative'); },
  });

  const rows = Array.isArray(records.data) ? records.data : [];
  const q = queue.data;
  const unresolved = (q?.eraUnresolved?.length ?? 0) + (q?.discrepancies?.length ?? 0);

  const recCols = [
    { key: 'source', header: 'Source', render: (r) => r.source || '—' },
    { key: 'billedAmount', header: 'Billed', align: 'right', render: (r) => money(r.billedAmount) },
    { key: 'amount', header: 'Paid', align: 'right', render: (r) => money(r.amount) },
    { key: 'matchStatus', header: 'Match', render: (r) => <Badge status={r.matchStatus || r.status} /> },
    { key: 'actions', header: '', align: 'right', render: (r) => (r.matchStatus && r.matchStatus !== 'RECONCILED') ? <Button variant="ghost" onClick={() => setConfirm({ record: r, target: 'RECONCILED', label: 'Mark reconciled' })}>Reconcile</Button> : null },
  ];

  return (
    <>
      <PageHeader title="Reconciliation" subtitle="Match payments to claims and clear discrepancies." />

      <motion.div className="rx-kpigrid" variants={gridVariants} initial="initial" animate="animate" style={{ marginBottom: 20 }}>
        <KpiCard icon={Icon.Chart} label="Records" value={rows.length} />
        <KpiCard icon={Icon.Inbox} label="Needs attention" value={unresolved} hint="unresolved + discrepancies" />
        <KpiCard icon={Icon.Return} label="Unresolved ERA" value={q?.eraUnresolved?.length ?? 0} />
        <KpiCard icon={Icon.Bell} label="Discrepancies" value={q?.discrepancies?.length ?? 0} />
      </motion.div>

      <Card title="Attention queue" hint="Items that need reconciling" style={{ marginBottom: 20 }}>
        {queue.isLoading ? <Spinner /> : queue.isError ? <ErrorState onRetry={() => queue.refetch()} />
          : unresolved === 0 ? <EmptyState icon={Icon.CheckCircle} title="All settled" body="Nothing needs attention right now." />
          : (
            <div className="rx-list">
              {(q.eraUnresolved || []).map((item) => (
                <div className="rx-row" key={item._id}>
                  <div className="rx-row__main"><div className="rx-row__title">ERA remittance</div><div className="rx-row__meta">{item.reference || '—'}</div></div>
                  <strong>{money(item.amount)}</strong><Badge status={item.matchStatus} />
                </div>
              ))}
              {(q.discrepancies || []).map((item) => (
                <div className="rx-row" key={item._id}>
                  <div className="rx-row__main"><div className="rx-row__title">{item.source} discrepancy</div><div className="rx-row__meta">{item.claimId || item.invoiceId || '—'}</div></div>
                  <strong>{money(item.amount)}</strong><Badge status="DENIED">{item.reason || 'discrepancy'}</Badge>
                </div>
              ))}
            </div>
          )}
      </Card>

      <Card title="All records">
        <DataTable query={records} rows={rows} getKey={(r) => r._id || r.id} columns={recCols}
          empty={<EmptyState icon={Icon.Chart} title="No records" body="Reconciliation records will appear here." />} />
      </Card>

      <Confirm open={!!confirm} title={confirm?.label} message={confirm ? 'Mark this record as reconciled?' : ''}
        confirmLabel="Reconcile" busy={transition.isPending} onCancel={() => setConfirm(null)} onConfirm={() => transition.mutate(confirm)} />
    </>
  );
}

export default ReconciliationRedesign;
