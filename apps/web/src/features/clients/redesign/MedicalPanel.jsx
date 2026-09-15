import { useState, useRef } from 'react';
import { usePermissions } from '@/auth/permissions';
import { motion, useReducedMotion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listMedical, addMedical, updateMedical, removeMedical, createDocument, uploadDocumentFile } from '@/api/client';
import { Card, Badge, Button, Icon, Spinner, ErrorState, EmptyState, Select, TextInput, Textarea, DateInput } from '@/ui';
import { Modal } from '@/ui';
import { useToast } from '@/components';
import { formatDate } from '@/lib/format';

/**
 * Medical Information — Conditions + History. Company/Admin (clients.medical.manage)
 * gets full add/edit/delete; every other role sees a clean read-only view. The
 * backend is authoritative (writes are rejected without the permission and the
 * RBT payload is already minimal), so this is presentation, not the security
 * boundary. All dates render MM/DD/YYYY.
 */
const STATUS = ['ACTIVE', 'RESOLVED', 'CHRONIC', 'MONITORING'];
const STATUS_OPTS = STATUS.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }));

export function MedicalPanel({ clientId }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canManage = permissions.includes('clients.medical.manage');
  const reduceMotion = useReducedMotion();
  const q = useQuery({ queryKey: ['client-medical', clientId], queryFn: () => listMedical(clientId) });
  const [editing, setEditing] = useState(null); // { type } for new, or full entry for edit

  const invalidate = () => qc.invalidateQueries({ queryKey: ['client-medical', clientId] });
  const save = useMutation({
    mutationFn: ({ id, body }) => (id ? updateMedical(clientId, id, body) : addMedical(clientId, body)),
    onSuccess: () => { invalidate(); setEditing(null); toast.push('Medical information saved.'); },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'Could not save.', 'negative'),
  });
  const remove = useMutation({
    mutationFn: (id) => removeMedical(clientId, id),
    onSuccess: () => { invalidate(); toast.push('Removed.'); },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'Could not remove.', 'negative'),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const entries = q.data ?? [];
  const conditions = entries.filter((m) => m.type === 'CONDITION');
  const history = entries.filter((m) => m.type === 'HISTORY');

  const Section = ({ title, type, items, icon }) => (
    <Card
      title={title}
      action={canManage ? <Button variant="subtle" icon={Icon.Plus} onClick={() => setEditing({ type })}>Add</Button> : undefined}
    >
      {items.length === 0
        ? <EmptyState icon={icon} title="No medical information added yet." body={canManage ? 'Add an entry to build the medical record.' : undefined} />
        : (
          <div className="rx-list">
            {items.map((m, i) => (
              // Subtle entrance only (no exit) — reduced-motion users get no movement,
              // and entrance-only animation avoids act()/unmount warnings in tests.
              <motion.div
                className="rx-row"
                key={m.id}
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: reduceMotion ? 0 : Math.min(i * 0.03, 0.15) }}
              >
                <div className="rx-row__main">
                  <div className="rx-row__title">{m.label}</div>
                  <div className="rx-row__meta">
                    {[m.onsetDate ? formatDate(m.onsetDate) : null, m.provider || null].filter(Boolean).join(' · ') || (m.status ? '' : '—')}
                  </div>
                  {m.notes ? <div className="rx-row__meta">{m.notes}</div> : null}
                  {Array.isArray(m.attachments) && m.attachments.length > 0 && (
                    <div className="rx-row__meta" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      {m.attachments.map((a) => (
                        <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.78rem', border: '1px solid var(--rx-line)', borderRadius: 6, padding: '1px 6px' }}>
                          <Icon.Doc size={12} />{a.title || 'Attachment'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {m.status ? <Badge status={m.status} /> : null}
                {canManage && (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <Button variant="ghost" aria-label="Edit" onClick={() => setEditing(m)}><Icon.Clipboard size={16} /></Button>
                    <Button variant="ghost" aria-label="Remove" onClick={() => remove.mutate(m.id)}><Icon.Logout size={16} /></Button>
                  </span>
                )}
              </motion.div>
            ))}
          </div>
        )}
    </Card>
  );

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Section title="Medical conditions" type="CONDITION" items={conditions} icon={Icon.Shield} />
      <Section title="Medical history" type="HISTORY" items={history} icon={Icon.Clipboard} />
      {editing && canManage && (
        <MedicalEditor
          entry={editing}
          clientId={clientId}
          saving={save.isPending}
          onCancel={() => setEditing(null)}
          onSave={(body) => save.mutate({ id: editing.id, body })}
        />
      )}
    </div>
  );
}

function MedicalEditor({ entry, clientId, onSave, onCancel, saving }) {
  const isEdit = Boolean(entry.id);
  const isCondition = entry.type === 'CONDITION';
  const [label, setLabel] = useState(entry.label ?? '');
  const [status, setStatus] = useState(entry.status ?? 'ACTIVE');
  const [provider, setProvider] = useState(entry.provider ?? '');
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [onsetDate, setOnsetDate] = useState(entry.onsetDate ? String(entry.onsetDate).slice(0, 10) : '');
  const [err, setErr] = useState('');
  // Attachments reuse the documents system: each picked file becomes a
  // ClinicalDocument (create → upload), and we keep its id to link on save.
  const existing = Array.isArray(entry.attachments) ? entry.attachments : [];
  const [attachments, setAttachments] = useState(existing.map((a) => ({ id: a.id, title: a.title || 'Attachment' })));
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const lastFileRef = useRef(null);
  // Must match the server's upload allowlist (DOCUMENT_ALLOWED_MIME_TYPES): image
  // (PNG/JPEG/TIFF) + PDF. webp is NOT allowed server-side, so offering it here
  // only produced a confusing rejection.
  const ACCEPT = 'application/pdf,image/png,image/jpeg,image/tiff';
  const prettySize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  async function uploadFile(file) {
    if (!file) return;
    lastFileRef.current = file;
    setErr(''); setUploading(true);
    try {
      // Real persistence: create the ClinicalDocument, then upload its bytes.
      // Nothing is added to the list unless the upload actually succeeds.
      const doc = await createDocument({ clientId, title: file.name });
      await uploadDocumentFile(doc.id, file);
      setAttachments((list) => [...list, { id: doc.id, title: file.name, size: file.size }]);
      lastFileRef.current = null;
    } catch (ex) {
      setErr(ex?.response?.data?.error?.message ?? 'Could not upload that file. Please try again.');
    } finally {
      setUploading(false);
    }
  }
  function onPickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    uploadFile(file);
  }
  function onDrop(e) {
    e.preventDefault(); setDragOver(false);
    if (uploading) return;
    uploadFile(e.dataTransfer?.files?.[0]);
  }

  function submit() {
    if (!label.trim()) { setErr('Enter a name.'); return; }
    const body = { type: entry.type, label: label.trim(), status };
    if (provider.trim()) body.provider = provider.trim();
    if (notes.trim()) body.notes = notes.trim();
    if (onsetDate) body.onsetDate = onsetDate;
    body.attachmentDocumentIds = attachments.map((a) => a.id);
    onSave(body);
  }

  const noun = isCondition ? 'condition' : 'history entry';
  const reduceMotion = useReducedMotion();
  return (
    <Modal open title={`${isEdit ? 'Edit' : 'Add'} ${noun}`} onClose={onCancel}>
      <motion.div
        style={{ display: 'grid', gap: 12 }}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <label className="rx-formfield">
          <span className="rx-formfield__label">{isCondition ? 'Condition' : 'Event / summary'}</span>
          <TextInput value={label} autoFocus onChange={(e) => setLabel(e.target.value)} placeholder={isCondition ? 'e.g. ADHD' : 'e.g. Seizure episode'} />
        </label>
        <label className="rx-formfield">
          <span className="rx-formfield__label">{isCondition ? 'Onset date' : 'Date'}</span>
          <DateInput value={onsetDate} onChange={(e) => setOnsetDate(e.target.value)} aria-label="Onset date" />
        </label>
        <label className="rx-formfield">
          <span className="rx-formfield__label">Status</span>
          {/* The shared Select is a custom control driven by an `options` prop and
              an onChange(value) — passing <option> children (as before) rendered an
              EMPTY, unusable dropdown (spec Module 3.3). Feed it real options. */}
          <Select value={status} onChange={setStatus} options={STATUS_OPTS} searchable={false} />
        </label>
        <label className="rx-formfield">
          <span className="rx-formfield__label">Provider</span>
          <TextInput value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Optional" />
        </label>
        <label className="rx-formfield">
          <span className="rx-formfield__label">Notes</span>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>
        <div className="rx-formfield">
          <span className="rx-formfield__label">Documents &amp; attachments</span>
          {attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {attachments.map((a) => (
                <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '.8rem', border: '1px solid var(--rx-line)', borderRadius: 8, padding: '4px 10px', background: 'var(--rx-canvas)' }}>
                  <Icon.Doc size={13} />{a.title}{a.size ? <span style={{ color: 'var(--rx-ink-faint)' }}>· {prettySize(a.size)}</span> : null}
                  <button type="button" aria-label="Remove attachment" onClick={() => setAttachments((l) => l.filter((x) => x.id !== a.id))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--rx-ink-faint)', fontSize: '1rem', lineHeight: 1 }}>×</button>
                </span>
              ))}
            </div>
          )}
          <div
            role="button"
            tabIndex={0}
            aria-label="Upload document — drag and drop or choose a file"
            onClick={() => { if (!uploading) fileRef.current?.click(); }}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !uploading) { e.preventDefault(); fileRef.current?.click(); } }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              display: 'grid', placeItems: 'center', gap: 6, textAlign: 'center',
              padding: '18px 14px', borderRadius: 12, cursor: uploading ? 'default' : 'pointer',
              border: `1.5px dashed ${dragOver ? 'var(--rx-accent)' : 'var(--rx-line)'}`,
              background: dragOver ? 'var(--rx-accent-tint)' : 'var(--rx-canvas)',
              transition: 'border-color .15s, background .15s',
            }}
          >
            {uploading ? (
              <><Spinner /><span className="rx-row__meta">Uploading…</span></>
            ) : (
              <>
                <div style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--rx-accent-tint)', color: 'var(--rx-accent-strong)' }}><Icon.Doc size={18} /></div>
                <div style={{ fontWeight: 600, fontSize: '.88rem' }}>Drag &amp; drop, or <span style={{ color: 'var(--rx-accent-strong)' }}>choose a file</span></div>
                <div className="rx-row__meta" style={{ fontSize: '.75rem' }}>PDF, PNG, JPG or TIFF</div>
              </>
            )}
            <input ref={fileRef} type="file" accept={ACCEPT} onChange={onPickFile} disabled={uploading} style={{ display: 'none' }} />
          </div>
          {err && lastFileRef.current && !uploading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
              <span className="rx-formfield__err" style={{ margin: 0 }}>{err}</span>
              <button type="button" className="rx-linkbtn" onClick={() => uploadFile(lastFileRef.current)}>Retry</button>
            </div>
          )}
        </div>
        {err && !lastFileRef.current && <p className="rx-formfield__err">{err}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button icon={Icon.Check} loading={saving} onClick={submit}>Save</Button>
        </div>
      </motion.div>
    </Modal>
  );
}

export default MedicalPanel;
