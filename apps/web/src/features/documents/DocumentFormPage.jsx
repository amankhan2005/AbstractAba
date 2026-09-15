import { useEffect, useState } from 'react';
import { formatFullName } from '@/lib/format';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createDocument, getDocument, listClients, updateDocument } from '@/api/client';
import { Button, Card, LoadingState, ErrorState } from '@/components';
import { DateInput } from '@/ui';

const TYPES = ['ASSESSMENT', 'CONSENT', 'TREATMENT_REPORT', 'AUTHORIZATION_LETTER', 'EVALUATION', 'PROGRESS_NOTE', 'CORRESPONDENCE', 'OTHER'];
const EMPTY = { clientId: '', documentType: 'OTHER', title: '', description: '', documentDate: '', expiresAt: '', storageRef: '', contentType: '' };

/**
 * File a new clinical document (DRAFT) or edit an existing draft. The file bytes
 * live in external storage referenced by storageRef; this form manages the
 * record metadata. A finalized document is immutable — the server refuses edits.
 */
export function DocumentFormPage() {
  const { documentId } = useParams();
  const isEdit = Boolean(documentId);
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [version, setVersion] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const clients = useQuery({ queryKey: ['clients', { limit: 100 }], queryFn: () => listClients({ limit: 100 }) });
  const detail = useQuery({ queryKey: ['document', documentId], queryFn: () => getDocument(documentId), enabled: isEdit });

  useEffect(() => {
    if (!isEdit || !detail.data) return;
    const d = detail.data;
    setForm({
      clientId: d.clientId,
      documentType: d.documentType ?? 'OTHER',
      title: d.title ?? '',
      description: d.description ?? '',
      documentDate: d.documentDate ? String(d.documentDate).slice(0, 10) : '',
      expiresAt: d.expiresAt ? String(d.expiresAt).slice(0, 10) : '',
      storageRef: d.storageRef ?? '',
      contentType: d.contentType ?? '',
    });
    setVersion(d.version);
  }, [isEdit, detail.data]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      let result;
      if (isEdit) {
        const body = {};
        for (const key of ['documentType', 'title', 'description', 'documentDate', 'expiresAt', 'storageRef', 'contentType']) {
          if (form[key]) body[key] = form[key];
        }
        result = await updateDocument(documentId, body, version);
      } else {
        const body = { clientId: form.clientId, documentType: form.documentType, title: form.title.trim() };
        for (const key of ['description', 'documentDate', 'expiresAt', 'storageRef', 'contentType']) {
          if (form[key]) body[key] = form[key];
        }
        result = await createDocument(body);
      }
      navigate(`/documents/${result.id}`);
    } catch (err) {
      setError(err.response?.data?.error?.message ?? 'Could not save the document.');
    } finally {
      setSaving(false);
    }
  };

  if (isEdit && detail.isLoading) return <LoadingState label="Loading document…" />;
  if (isEdit && detail.isError) return <ErrorState message="Could not load the document." />;

  return (
    <div className="ui-stack">
      <h1>{isEdit ? 'Edit document' : 'New document'}</h1>
      <Card>
        <form className="ui-fields" onSubmit={submit}>
          {!isEdit ? (
            <label className="ui-field">
              <span>Client</span>
              <select className="input" value={form.clientId} onChange={set('clientId')} required>
                <option value="">Select a client…</option>
                {(clients.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{formatFullName(c)} ({c.clientNumber})</option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="ui-field">
            <span>Type</span>
            <select className="input" value={form.documentType} onChange={set('documentType')}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>

          <label className="ui-field">
            <span>Title</span>
            <input className="input" value={form.title} onChange={set('title')} required maxLength={300} />
          </label>

          <label className="ui-field">
            <span>Description</span>
            <textarea className="input" rows={3} value={form.description} onChange={set('description')} />
          </label>

          <div className="ui-row">
            <label className="ui-field">
              <span>Document date</span>
              <DateInput value={form.documentDate} onChange={set('documentDate')} aria-label="Document date" />
            </label>
            <label className="ui-field">
              <span>Expires</span>
              <DateInput value={form.expiresAt} onChange={set('expiresAt')} aria-label="Expires" />
            </label>
          </div>

          <label className="ui-field">
            <span>Storage reference (external file key)</span>
            <input className="input" value={form.storageRef} onChange={set('storageRef')} placeholder="obj/…" />
          </label>

          {error ? <p className="form-error" role="alert">{error}</p> : null}

          <div className="ui-row">
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save document'}</Button>
            <Button type="button" variant="ghost" onClick={() => navigate('/documents')}>Cancel</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
