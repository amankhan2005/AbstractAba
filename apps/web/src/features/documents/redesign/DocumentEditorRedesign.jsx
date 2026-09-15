import { useEffect, useRef, useState } from 'react';
import { formatFullName } from '@/lib/format';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { createDocument, getDocument, updateDocument, uploadDocumentFile, finalizeDocument, listClients } from '@/api/client';
import { useToast } from '@/components';
import { PageHeader, Card, Button, Icon, Badge, Field, TextInput, DateInput, Textarea, Select, Spinner, ErrorState, Confirm } from '@/ui';

/**
 * Document create/edit + upload. Metadata is saved through create/updateDocument
 * (edits use the If-Match version for concurrency); the file is uploaded through
 * the existing secure endpoint (uploadDocumentFile base64-encodes client-side —
 * no storage secrets touch the browser). Finalize locks the record. Real APIs
 * only; fields follow the backend contract.
 */
const EMPTY = { clientId: '', documentType: 'OTHER', title: '', description: '', documentDate: '', expiresAt: '' };
const TYPE_OPTS = [
  { value: 'ASSESSMENT', label: 'Assessment' }, { value: 'TREATMENT_PLAN', label: 'Treatment plan' },
  { value: 'PROGRESS_NOTE', label: 'Progress note' }, { value: 'CONSENT', label: 'Consent' },
  { value: 'AUTHORIZATION', label: 'Authorization' }, { value: 'OTHER', label: 'Other' },
];
const ACCEPT = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 15 * 1024 * 1024;

export function DocumentEditorRedesign() {
  const { documentId } = useParams();
  const isEdit = Boolean(documentId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState(EMPTY);
  const [version, setVersion] = useState(null);
  const [errors, setErrors] = useState({});
  const [dragOver, setDragOver] = useState(false);
  const [fileError, setFileError] = useState(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const fileRef = useRef(null);
  const set = (key) => (v) => setForm((f) => ({ ...f, [key]: typeof v === 'string' ? v : v.target.value }));

  const existing = useQuery({ queryKey: ['document', documentId], queryFn: () => getDocument(documentId), enabled: isEdit });
  const clients = useQuery({ queryKey: ['clients', 'opts'], queryFn: () => listClients({}) });

  useEffect(() => {
    if (existing.data) {
      const d = existing.data;
      setForm({ clientId: d.clientId, documentType: d.documentType ?? 'OTHER', title: d.title ?? '', description: d.description ?? '',
        documentDate: d.documentDate ? String(d.documentDate).slice(0, 10) : '', expiresAt: d.expiresAt ? String(d.expiresAt).slice(0, 10) : '' });
      setVersion(d.version);
    }
  }, [existing.data]);

  const clientOpts = (clients.data?.items ?? []).map((c) => ({ value: c.id, label: formatFullName(c) }));
  const status = existing.data?.status;
  const hasFile = Boolean(existing.data?.fileName || existing.data?.storageRef);
  const isFinalized = status === 'FINALIZED';

  const save = useMutation({
    mutationFn: () => {
      if (isEdit) {
        const body = {};
        for (const k of ['documentType', 'title', 'description', 'documentDate', 'expiresAt']) if (form[k]) body[k] = form[k];
        return updateDocument(documentId, body, version);
      }
      const body = { clientId: form.clientId, documentType: form.documentType, title: form.title.trim() };
      for (const k of ['description', 'documentDate', 'expiresAt']) if (form[k]) body[k] = form[k];
      return createDocument(body);
    },
    onSuccess: (result) => { qc.invalidateQueries({ queryKey: ['documents'] }); toast.push(isEdit ? 'Document saved.' : 'Document created.'); navigate(`/documents/${result.id ?? documentId}`); },
    onError: (err) => setErrors({ submit: err?.response?.status === 412 ? 'This document changed since you opened it. Reload and reapply your edits.' : 'Could not save. Check the required fields and try again.' }),
  });

  const upload = useMutation({
    mutationFn: (file) => uploadDocumentFile(documentId, file),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['document', documentId] }); toast.push('File uploaded.'); },
    onError: () => toast.push('Could not upload the file. Please try again.', 'negative'),
  });
  const finalize = useMutation({
    mutationFn: () => finalizeDocument(documentId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['document', documentId] }); qc.invalidateQueries({ queryKey: ['documents'] }); setConfirmFinalize(false); toast.push('Document finalized.'); },
    onError: (e) => { setConfirmFinalize(false); toast.push(e?.response?.data?.error?.message ?? 'Could not finalize.', 'negative'); },
  });

  function pickFile(file) {
    setFileError(null);
    if (!file) return;
    if (!ACCEPT.includes(file.type)) { setFileError('Please choose a PDF, PNG, JPG or WebP file.'); return; }
    if (file.size > MAX_BYTES) { setFileError('That file is too large (15 MB max).'); return; }
    upload.mutate(file);
  }

  function submit() {
    const e = {};
    if (!isEdit && !form.clientId) e.clientId = 'Choose the child this document belongs to.';
    if (!form.title.trim()) e.title = 'A title is required.';
    setErrors(e);
    if (Object.keys(e).length === 0) save.mutate();
  }

  if (isEdit && existing.isLoading) return <Spinner />;
  if (isEdit && existing.isError) return <ErrorState onRetry={() => existing.refetch()} />;

  return (
    <>
      <PageHeader title={isEdit ? 'Edit document' : 'New document'} subtitle="Record metadata and attach the file. Finalizing locks the document."
        actions={isEdit && status ? <Badge status={status} /> : null} />

      <div className="rx-cols-2">
        <Card title="Details">
          {!isEdit && <Field label="Child" required error={errors.clientId}><Select value={form.clientId} onChange={set('clientId')} options={clientOpts} loading={clients.isLoading} placeholder="Select a child…" /></Field>}
          <Field label="Title" required error={errors.title}><TextInput value={form.title} onChange={set('title')} icon={Icon.Doc} disabled={isFinalized} /></Field>
          <Field label="Type"><Select value={form.documentType} onChange={set('documentType')} options={TYPE_OPTS} searchable={false} disabled={isFinalized} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Document date" hint="MM/DD/YYYY"><DateInput value={form.documentDate} onChange={set('documentDate')} disabled={isFinalized} aria-label="Document date" /></Field>
            <Field label="Expires" hint="MM/DD/YYYY"><DateInput value={form.expiresAt} onChange={set('expiresAt')} disabled={isFinalized} aria-label="Expires" /></Field>
          </div>
          <Field label="Description"><Textarea value={form.description} onChange={set('description')} rows={4} disabled={isFinalized} /></Field>
        </Card>

        <Card title="File" hint={isEdit ? 'PDF, PNG, JPG or WebP · 15 MB max' : 'Save the document first, then attach a file'}>
          {!isEdit ? (
            <div className="rx-state"><div className="rx-state__icon"><Icon.Doc size={22} /></div><div className="rx-state__body">Create the document, then you can upload its file here.</div></div>
          ) : (
            <>
              <div
                className={`rx-dropzone${dragOver ? ' is-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); if (!isFinalized) setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!isFinalized) pickFile(e.dataTransfer.files?.[0]); }}
                onClick={() => !isFinalized && fileRef.current?.click()}
                role="button" aria-disabled={isFinalized}
              >
                {upload.isPending ? <><div className="rx-spinner" /><span>Uploading…</span></>
                  : <><div className="rx-state__icon"><Icon.Plus size={22} /></div>
                      <div className="rx-state__title">{hasFile ? 'Replace file' : 'Drag & drop or click to upload'}</div>
                      <div className="rx-state__body">{isFinalized ? 'This document is finalized and cannot be changed.' : 'PDF, PNG, JPG or WebP up to 15 MB'}</div></>}
                <input ref={fileRef} type="file" accept={ACCEPT.join(',')} style={{ display: 'none' }} onChange={(e) => pickFile(e.target.files?.[0])} disabled={isFinalized} />
              </div>
              {fileError && <p className="rx-formfield__err" style={{ marginTop: 10 }}>{fileError}</p>}
              {hasFile && <div className="rx-row" style={{ marginTop: 12 }}><Icon.Doc size={18} /><div className="rx-row__main"><div className="rx-row__title">{existing.data.fileName || 'Attached file'}</div></div><Badge status="APPROVED">attached</Badge></div>}
            </>
          )}
        </Card>
      </div>

      {errors.submit && <p className="rx-formfield__err" style={{ marginTop: 14 }}>{errors.submit}</p>}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 20 }}>
        <div>{isEdit && !isFinalized && hasFile && <Button variant="ghost" icon={Icon.CheckCircle} onClick={() => setConfirmFinalize(true)}>Finalize</Button>}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="ghost" onClick={() => navigate(isEdit ? `/documents/${documentId}` : '/documents')}>Cancel</Button>
          {!isFinalized && <Button onClick={submit} loading={save.isPending} icon={Icon.Check}>{isEdit ? 'Save changes' : 'Create document'}</Button>}
        </div>
      </div>

      <Confirm open={confirmFinalize} title="Finalize document" tone="danger"
        message="Finalizing locks this document — its metadata and file can no longer be changed. Continue?"
        confirmLabel="Finalize" busy={finalize.isPending} onCancel={() => setConfirmFinalize(false)} onConfirm={() => finalize.mutate()} />
    </>
  );
}

export default DocumentEditorRedesign;
