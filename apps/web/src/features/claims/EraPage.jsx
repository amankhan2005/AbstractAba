import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchEraFiles, uploadEraFile, fetchEraRecords, resolveEraRecord } from '@/api/client';
import { Card, Button, StatusBadge, LoadingState, ErrorState, EmptyState, ConfirmDialog } from '@/components';
import { formatMoney } from './money.js';
import { formatDate } from '@/lib/format';

function fileTone(s) { return { PROCESSED: 'success', PROCESSING: 'info', RECEIVED: 'neutral', FAILED: 'danger' }[s] ?? 'neutral'; }
function matchTone(s) { return { MATCHED: 'success', RESOLVED: 'success', AMBIGUOUS: 'warning', UNMATCHED: 'danger', INVALID: 'danger' }[s] ?? 'neutral'; }

/**
 * ERA / remittance. Upload reads the selected 835 file's text and calls the real
 * upload API (no fake success); processing runs asynchronously on the server.
 * Unmatched/ambiguous records can be resolved to a claim by entering its id.
 */
export function EraPage() {
  const qc = useQueryClient();
  const [error, setError] = useState(null);
  const [resolveTarget, setResolveTarget] = useState(null);
  const [resolveClaimId, setResolveClaimId] = useState('');
  const files = useQuery({ queryKey: ['era-files'], queryFn: () => fetchEraFiles({}) });
  const records = useQuery({ queryKey: ['era-records'], queryFn: () => fetchEraRecords({}) });

  const upload = useMutation({
    mutationFn: async (file) => {
      const content = await file.text();
      return uploadEraFile({ fileName: file.name, content });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['era-files'] }); qc.invalidateQueries({ queryKey: ['era-records'] }); },
    onError: (err) => setError(err?.response?.data?.error?.message ?? 'Upload failed.'),
  });

  const resolve = useMutation({
    mutationFn: () => resolveEraRecord(resolveTarget._id, resolveClaimId.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['era-records'] });
      qc.invalidateQueries({ queryKey: ['claims'] });
      setResolveTarget(null); setResolveClaimId('');
    },
    onError: (err) => setError(err?.response?.data?.error?.message ?? 'Could not resolve record.'),
  });

  function onFile(e) {
    setError(null);
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
    e.target.value = '';
  }

  return (
    <div className="claims">
      <h1 className="page-title">ERA / Remittance</h1>

      <Card>
        <h2 className="card-title">Upload 835 file</h2>
        <p className="muted">Upload a payer 835 remittance file. It is parsed and matched to claims on the server.</p>
        <input type="file" accept=".txt,.835,.edi,text/plain" onChange={onFile} disabled={upload.isPending} aria-label="Upload 835 file" />
        {upload.isPending ? <p className="muted">Uploading…</p> : null}
        {error ? <p className="form-error">{error}</p> : null}
      </Card>

      <Card>
        <h2 className="card-title">Files</h2>
        {files.isLoading ? <LoadingState label="Loading files…" />
          : files.isError ? <ErrorState message="Could not load files." onRetry={() => files.refetch()} />
          : files.data.length === 0 ? <EmptyState message="No ERA files uploaded yet." />
          : (
            <table className="ui-table">
              <thead><tr><th>File</th><th>Received</th><th>Status</th><th>Parsed</th><th>Matched</th><th>Unmatched</th><th>Paid total</th></tr></thead>
              <tbody>
                {files.data.map((f) => (
                  <tr key={f._id}>
                    <td>{f.fileName}</td>
                    <td>{formatDate(f.createdAt)}</td>
                    <td><StatusBadge tone={fileTone(f.status)}>{f.status}</StatusBadge>{f.failureReason ? <div className="muted">{f.failureReason}</div> : null}</td>
                    <td>{f.claimsParsed}</td>
                    <td>{f.matched}</td>
                    <td>{f.unmatched + f.ambiguous}</td>
                    <td>{formatMoney(f.totalPaidAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      <Card>
        <h2 className="card-title">Remittance records</h2>
        {records.isLoading ? <LoadingState label="Loading records…" />
          : records.isError ? <ErrorState message="Could not load records." onRetry={() => records.refetch()} />
          : records.data.length === 0 ? <EmptyState message="No remittance records yet." />
          : (
            <table className="ui-table">
              <thead><tr><th>Claim ref</th><th>Payer control #</th><th>Charge</th><th>Paid</th><th>Match</th><th></th></tr></thead>
              <tbody>
                {records.data.map((r) => (
                  <tr key={r._id}>
                    <td>{r.claimNumberRef || '—'}</td>
                    <td>{r.payerControlNumber || '—'}</td>
                    <td>{formatMoney(r.chargeAmount)}</td>
                    <td>{formatMoney(r.paidAmount)}</td>
                    <td><StatusBadge tone={matchTone(r.matchStatus)}>{r.matchStatus}</StatusBadge></td>
                    <td>{(r.matchStatus === 'UNMATCHED' || r.matchStatus === 'AMBIGUOUS') && !r.postedPaymentId
                      ? <Button variant="ghost" onClick={() => { setResolveTarget(r); setError(null); }}>Resolve</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>

      {resolveTarget ? (
        <ConfirmDialog
          title="Resolve remittance record"
          message={(
            <>Enter the claim id to post this remittance ({formatMoney(resolveTarget.paidAmount)}) to:
              <input className="ui-input" style={{ marginTop: '0.5rem', width: '100%' }} value={resolveClaimId}
                onChange={(e) => setResolveClaimId(e.target.value)} placeholder="claim id" aria-label="Claim id" />
            </>
          )}
          confirmLabel="Resolve & post"
          busy={resolve.isPending}
          onConfirm={() => resolveClaimId.trim() && resolve.mutate()}
          onClose={() => { setResolveTarget(null); setResolveClaimId(''); }}
        />
      ) : null}
    </div>
  );
}
