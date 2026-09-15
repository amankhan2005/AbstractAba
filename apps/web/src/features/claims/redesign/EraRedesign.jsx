import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchEraFiles, fetchEraRecords, resolveEraRecord, uploadEraFile } from '@/api/client';
import { useToast } from '@/components';
import { PageHeader, Card, Badge, Icon, DataTable, Button, Modal, Field, TextInput, EmptyState } from '@/ui';
import { formatDate } from '@/lib/format';

/**
 * ERA (835 remittance) — uploaded files and their parsed records. Files are
 * parsed and matched to claims on the server; unmatched records can be resolved
 * to a claim id. Real APIs throughout; no fabricated remittance data.
 */
const money = (c) => (c == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(c / 100));

export function EraRedesign() {
  const qc = useQueryClient();
  const toast = useToast();
  const [resolving, setResolving] = useState(null);
  const [claimId, setClaimId] = useState('');

  const files = useQuery({ queryKey: ['era-files'], queryFn: () => fetchEraFiles({}) });
  const records = useQuery({ queryKey: ['era-records'], queryFn: () => fetchEraRecords({}) });

  const upload = useMutation({
    mutationFn: (dataUrl) => uploadEraFile(dataUrl),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['era-files'] }); qc.invalidateQueries({ queryKey: ['era-records'] }); toast.push('ERA file uploaded.'); },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'Could not upload the file.', 'negative'),
  });
  const resolve = useMutation({
    mutationFn: () => resolveEraRecord(resolving._id ?? resolving.id, { claimId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['era-records'] }); setResolving(null); setClaimId(''); toast.push('Record matched to claim.'); },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'Could not match the record.', 'negative'),
  });

  function onFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => upload.mutate(String(reader.result));
    reader.readAsDataURL(file);
  }

  const fileCols = [
    { key: 'name', header: 'File', render: (f) => <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon.Doc size={16} />{f.fileName || f.name || f._id}</span> },
    { key: 'createdAt', header: 'Uploaded', render: (f) => (f.createdAt ? formatDate(f.createdAt) : '—') },
    { key: 'status', header: 'Status', render: (f) => <><Badge status={f.status} />{f.failureReason ? <div className="rx-row__meta">{f.failureReason}</div> : null}</> },
  ];
  const recCols = [
    { key: 'payer', header: 'Payer', render: (r) => r.payer || '—' },
    { key: 'claimNumber', header: 'Claim', render: (r) => r.claimNumber || '—' },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r.amount) },
    { key: 'matchStatus', header: 'Match', render: (r) => <Badge status={r.matchStatus} /> },
    { key: 'actions', header: '', align: 'right', render: (r) => (r.matchStatus && r.matchStatus !== 'MATCHED') ? <Button variant="ghost" onClick={() => setResolving(r)}>Match</Button> : null },
  ];

  return (
    <>
      <PageHeader title="ERA remittances" subtitle="Upload payer 835 files; records are parsed and matched to claims automatically."
        actions={<label className="rx-btn rx-btn--primary" style={{ cursor: 'pointer' }}><Icon.Plus size={16} /> {upload.isPending ? 'Uploading…' : 'Upload 835'}<input type="file" style={{ display: 'none' }} onChange={(e) => onFile(e.target.files?.[0])} disabled={upload.isPending} /></label>} />

      <Card title="Files" style={{ marginBottom: 20 }}>
        <DataTable query={files} getKey={(f) => f._id || f.id} columns={fileCols}
          empty={<EmptyState icon={Icon.Doc} title="No ERA files yet" body="Upload a payer 835 remittance file to begin." />} />
      </Card>
      <Card title="Records">
        <DataTable query={records} getKey={(r) => r._id || r.id} columns={recCols}
          empty={<EmptyState icon={Icon.CheckCircle} title="No records" body="Parsed remittance records will appear here." />} />
      </Card>

      <Modal open={!!resolving} onClose={() => setResolving(null)} title="Match to claim" description="Enter the claim id this remittance record belongs to." size="sm"
        footer={<><Button variant="ghost" onClick={() => setResolving(null)}>Cancel</Button><Button onClick={() => resolve.mutate()} loading={resolve.isPending} disabled={!claimId.trim()}>Match record</Button></>}>
        <Field label="Claim id" required><TextInput value={claimId} onChange={(e) => setClaimId(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

export default EraRedesign;
