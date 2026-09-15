import { formatDate, formatDateTime } from '@/lib/format';
import { usePermissions } from '@/auth/permissions';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { archiveDocument, finalizeDocument, getDocument, supersedeDocument, uploadDocumentFile, downloadDocumentFile } from '@/api/client';
import { Button, Card, LoadingState, ErrorState } from '@/components';

/**
 * Clinical document detail + lifecycle. A DRAFT can be edited, finalized, or
 * archived; a FINALIZED document is read-only and can be archived or superseded
 * (which files a linked new draft). Lifecycle actions require documents.finalize.
 * A DRAFT's binary artifact can be uploaded (documents.write); any attached file
 * can be downloaded (documents.read). The server validates and stores the bytes.
 */
export function DocumentDetailPage() {
  const { documentId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canWrite = permissions.includes('documents.write');
  const canFinalize = permissions.includes('documents.finalize');

  const detail = useQuery({ queryKey: ['document', documentId], queryFn: () => getDocument(documentId) });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['document', documentId] });

  const finalizeMut = useMutation({ mutationFn: () => finalizeDocument(documentId), onSuccess: invalidate });
  const archiveMut = useMutation({ mutationFn: () => archiveDocument(documentId), onSuccess: invalidate });
  const uploadMut = useMutation({ mutationFn: (file) => uploadDocumentFile(documentId, file), onSuccess: invalidate });
  const supersedeMut = useMutation({
    mutationFn: () => supersedeDocument(documentId, { title: `${detail.data.title} (revision)`, documentType: detail.data.documentType }),
    onSuccess: (next) => navigate(`/documents/${next.id}/edit`),
  });

  async function handleDownload() {
    const blob = await downloadDocumentFile(documentId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = detail.data?.title || 'document';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function onFileChange(e) {
    const file = e.target.files?.[0];
    if (file) uploadMut.mutate(file);
    e.target.value = '';
  }

  if (detail.isLoading) return <LoadingState label="Loading document…" />;
  if (detail.isError) return <ErrorState message="Could not load the document." onRetry={() => detail.refetch()} />;

  const d = detail.data;
  const isDraft = d.status === 'DRAFT';
  const isFinalized = d.status === 'FINALIZED';

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>{d.title}</h1>
        <Link className="linklike" to="/documents">← All documents</Link>
      </div>

      <Card>
        <p className="muted">
          {d.documentType} · {d.status}
          {d.finalizedAt ? ` · finalized ${formatDateTime(d.finalizedAt)}` : ''}
          {d.documentDate ? ` · dated ${formatDate(d.documentDate)}` : ''}
          {d.expiresAt ? ` · expires ${formatDate(d.expiresAt)}` : ''}
        </p>
        {d.description ? <p>{d.description}</p> : <p className="muted">No description.</p>}
        <div className="ui-stack" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
          {d.storageRef ? (
            <div className="ui-row" style={{ gap: '0.75rem', alignItems: 'center' }}>
              <span className="muted">File attached{d.sizeBytes ? ` · ${(d.sizeBytes / 1024).toFixed(1)} KB` : ''}{d.contentType ? ` · ${d.contentType}` : ''}</span>
              <Button type="button" variant="ghost" onClick={handleDownload}>Download</Button>
            </div>
          ) : <p className="muted">No file attached.</p>}
          {isDraft && canWrite ? (
            <div className="ui-row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input type="file" onChange={onFileChange} disabled={uploadMut.isPending} aria-label="Upload document file" />
              {uploadMut.isPending ? <span className="muted">Uploading…</span> : null}
            </div>
          ) : null}
          {uploadMut.isError ? <p className="form-error" role="alert">{uploadMut.error?.response?.data?.error?.message ?? 'Could not upload the file.'}</p> : null}
        </div>
        {d.supersededByDocumentId ? (
          <p className="muted">Superseded by <Link to={`/documents/${d.supersededByDocumentId}`}>a newer version</Link>.</p>
        ) : null}
        {d.supersedesDocumentId ? (
          <p className="muted">Supersedes <Link to={`/documents/${d.supersedesDocumentId}`}>an earlier version</Link>.</p>
        ) : null}
      </Card>

      <Card>
        <div className="ui-row">
          {isDraft && canWrite ? <Button type="button" variant="ghost" onClick={() => navigate(`/documents/${documentId}/edit`)}>Edit</Button> : null}
          {isDraft && canFinalize ? <Button type="button" onClick={() => finalizeMut.mutate()} disabled={finalizeMut.isPending}>{finalizeMut.isPending ? 'Finalizing…' : 'Finalize'}</Button> : null}
          {isFinalized && canFinalize && !d.supersededByDocumentId ? <Button type="button" onClick={() => supersedeMut.mutate()} disabled={supersedeMut.isPending}>{supersedeMut.isPending ? 'Superseding…' : 'Supersede'}</Button> : null}
          {d.status !== 'ARCHIVED' && canFinalize ? <Button type="button" variant="ghost" onClick={() => archiveMut.mutate()} disabled={archiveMut.isPending}>Archive</Button> : null}
        </div>
        {finalizeMut.isError ? <p className="form-error" role="alert">Could not finalize the document.</p> : null}
        {archiveMut.isError ? <p className="form-error" role="alert">Could not archive the document.</p> : null}
        {supersedeMut.isError ? <p className="form-error" role="alert">Could not supersede the document.</p> : null}
      </Card>
    </div>
  );
}
