import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { previewImport, commitImport, listExports, generateExport, downloadExport } from '@/api/client';
import { Card, Button, StatusBadge, LoadingState, ErrorState, EmptyState, ConfirmDialog, useToast } from '@/components';
import { formatDateTime } from '@/lib/format';

/**
 * Bulk data tools: CSV import (clients / staff) with a dry-run preview before
 * committing, and organization export. Importing clients requires
 * clients.create; importing staff requires staff.manage; export requires
 * organization.export. The backend authorizes every action; the UI only mirrors
 * the gates. No browser dialogs — ConfirmDialog + toast.
 */
export function DataToolsPage() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canImportClients = permissions.includes('clients.create');
  const canImportStaff = permissions.includes('staff.manage');
  const canExport = permissions.includes('organization.export');
  const toast = useToast();
  const queryClient = useQueryClient();

  const [entity, setEntity] = useState(canImportClients ? 'clients' : 'staff');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirm, setConfirm] = useState(false);

  const previewMut = useMutation({
    mutationFn: () => previewImport(entity, file),
    onSuccess: (res) => { setPreview(res); },
    onError: (err) => toast.push(err?.response?.data?.error?.message ?? 'Could not preview the file.', 'negative'),
  });
  const commitMut = useMutation({
    mutationFn: () => commitImport(entity, file),
    onSuccess: (res) => {
      setConfirm(false); setPreview(null); setFile(null);
      toast.push(`Imported ${res.created} ${entity}; ${res.failed} failed.`);
    },
    onError: (err) => { setConfirm(false); toast.push(err?.response?.data?.error?.message ?? 'Import failed.', 'negative'); },
  });

  const exportsQuery = useQuery({ queryKey: ['org-exports'], queryFn: listExports, enabled: canExport });
  const generateMut = useMutation({
    mutationFn: generateExport,
    onSuccess: async () => { toast.push('Export generated.'); await queryClient.invalidateQueries({ queryKey: ['org-exports'] }); },
    onError: (err) => toast.push(err?.response?.data?.error?.message ?? 'Export failed.', 'negative'),
  });

  async function handleDownload(id) {
    try {
      const blob = await downloadExport(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `organization-export-${id}.txt`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch { toast.push('Could not download the export.', 'negative'); }
  }

  const onFile = (e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); };
  const canImport = (entity === 'clients' && canImportClients) || (entity === 'staff' && canImportStaff);

  return (
    <div className="ui-stack">
      <h1>Data tools</h1>

      {(canImportClients || canImportStaff) ? (
        <Card>
          <h2>Import from CSV</h2>
          <div className="ui-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            {canImportClients ? <button type="button" className={`chip${entity === 'clients' ? ' chip--active' : ''}`} onClick={() => { setEntity('clients'); setPreview(null); }}>Clients</button> : null}
            {canImportStaff ? <button type="button" className={`chip${entity === 'staff' ? ' chip--active' : ''}`} onClick={() => { setEntity('staff'); setPreview(null); }}>Staff</button> : null}
          </div>
          <p className="muted">
            {entity === 'clients'
              ? 'Columns: firstName, lastName, clientNumber (required); status, email, phone, primaryLanguage (optional).'
              : 'Columns: userId, firstName, lastName (required); title, discipline, employeeNumber, status (optional).'}
          </p>
          <div className="ui-row" style={{ gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
            <input type="file" accept=".csv,text/csv" onChange={onFile} aria-label="CSV file" />
            <Button type="button" disabled={!file || !canImport || previewMut.isPending} onClick={() => previewMut.mutate()}>
              {previewMut.isPending ? 'Checking…' : 'Preview'}
            </Button>
          </div>

          {preview ? (
            <div className="ui-stack" style={{ marginTop: '0.75rem' }}>
              <p><strong>{preview.summary.valid}</strong> valid · <strong>{preview.summary.invalid}</strong> invalid · <strong>{preview.summary.duplicates}</strong> duplicate of {preview.summary.total} rows.</p>
              {preview.invalid.length ? (
                <Card>
                  <p className="muted">Rows that will be skipped:</p>
                  <ul className="ui-list">
                    {preview.invalid.slice(0, 50).map((r) => <li key={r.__row} className="muted">Row {r.__row}: {r.errors.join('; ')}</li>)}
                  </ul>
                </Card>
              ) : null}
              <div className="ui-row">
                <Button type="button" disabled={preview.summary.valid === 0 || commitMut.isPending} onClick={() => setConfirm(true)}>
                  Import {preview.summary.valid} {entity}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {canExport ? (
        <Card>
          <div className="ui-row" style={{ justifyContent: 'space-between' }}>
            <h2>Organization export</h2>
            <Button type="button" disabled={generateMut.isPending} onClick={() => generateMut.mutate()}>
              {generateMut.isPending ? 'Generating…' : 'Generate export'}
            </Button>
          </div>
          {exportsQuery.isLoading ? <LoadingState label="Loading exports…" />
            : exportsQuery.isError ? <ErrorState message="Could not load exports." onRetry={() => exportsQuery.refetch()} />
            : (exportsQuery.data ?? []).length === 0 ? <EmptyState message="No exports yet." />
            : (
              <table className="ui-table">
                <thead><tr><th>Requested</th><th>State</th><th>Size</th><th /></tr></thead>
                <tbody>
                  {exportsQuery.data.map((e) => (
                    <tr key={e.id}>
                      <td>{e.requestedAt ? formatDateTime(e.requestedAt) : '—'}</td>
                      <td><StatusBadge status={e.state} /></td>
                      <td>{e.sizeBytes ? `${(e.sizeBytes / 1024).toFixed(1)} KB` : '—'}</td>
                      <td>{e.state === 'AVAILABLE' || e.state === 'DOWNLOADED' ? <Button variant="ghost" onClick={() => handleDownload(e.id)}>Download</Button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Card>
      ) : null}

      <ConfirmDialog
        open={!!confirm}
        title={`Import ${preview?.summary.valid ?? 0} ${entity}?`}
        message="Only the valid rows shown will be created. Invalid and duplicate rows are skipped and never modify existing records."
        confirmLabel="Import"
        onConfirm={() => commitMut.mutate()}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
