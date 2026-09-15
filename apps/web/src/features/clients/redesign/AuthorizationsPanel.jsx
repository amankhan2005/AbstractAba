import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { listServiceAuthorizations, createServiceAuthorization, updateServiceAuthorization, transitionServiceAuthorization, archiveServiceAuthorization } from '@/api/client';
import { useToast } from '@/components';
import { Card, Button, Badge, Icon, Modal, Field, TextInput, Textarea, Select, Spinner, ErrorState, EmptyState, Confirm, DateInput } from '@/ui';
import { formatDate, formatDateTime, todayLocalISO } from '@/lib/format';

/**
 * FBA + ABA authorizations. A child may hold MULTIPLE authorizations of each
 * type (different periods/payers), each an independent record with its own
 * status, units and lifecycle. The server owns every transition (NOT_SENT → SENT
 * → APPROVED/DENIED); this panel only offers the transitions valid from the
 * current state and surfaces the backend's error for anything it refuses.
 * An authorization is usable (booking, manual sessions, billing) as soon as it
 * is saved; the payer workflow is tracking only, and only DENIED blocks use.
 *
 * SAVING IS NOT APPROVAL. "Add ABA/FBA" persists the record immediately through
 * POST /clients/:id/authorizations (status NOT_SENT) and shows it at once —
 * no "Mark sent" or "Approve" click is needed to keep it. Sending to the payer
 * and the approve/deny decision remain the separate, optional payer review.
 */
const TYPES = [{ type: 'ABA', label: 'ABA authorizations' }, { type: 'FBA', label: 'FBA authorizations' }];
const STATUS_LABEL = { NOT_SENT: 'Not sent', SENT: 'Sent', APPROVED: 'Approved', DENIED: 'Denied' };
const NEXT = { NOT_SENT: ['SENT'], SENT: ['APPROVED', 'DENIED'], APPROVED: [], DENIED: ['SENT'] };
const fmtDate = (d) => (d ? formatDate(d) : null);
const orNP = (v) => (v == null || v === '' ? <span style={{ color: 'var(--rx-ink-faint)' }}>Not provided</span> : v);

export function AuthorizationsPanel({ clientId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: ['authorizations', clientId], queryFn: () => listServiceAuthorizations(clientId) });
  const [editing, setEditing] = useState(null); // { type, auth? }
  const [review, setReview] = useState(null); // { auth, target }
  const [deleting, setDeleting] = useState(null); // auth to archive

  // Everything derived from authorizations: this list, the client header (FBA/ABA
  // status), the roster, and the child alerts.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['authorizations', clientId] });
    qc.invalidateQueries({ queryKey: ['client', clientId] });
    qc.invalidateQueries({ queryKey: ['clients'] });
    qc.invalidateQueries({ queryKey: ['child-alerts', clientId] });
  };
  // Put the server's saved record into the list straight away (no refresh), then
  // refetch so the list stays authoritative.
  const upsert = (saved) => {
    if (!saved?.id) return;
    qc.setQueryData(['authorizations', clientId], (cur) => {
      if (!Array.isArray(cur)) return cur;
      return cur.some((a) => a.id === saved.id) ? cur.map((a) => (a.id === saved.id ? saved : a)) : [...cur, saved];
    });
  };

  const save = useMutation({
    mutationFn: ({ type, auth, body }) => (auth ? updateServiceAuthorization(clientId, auth.id, body) : createServiceAuthorization(clientId, { serviceType: type, ...body })),
    onSuccess: (saved, vars) => {
      upsert(saved);
      invalidate();
      setEditing(null);
      toast.push(vars.auth ? `${vars.type} authorization updated.` : `${vars.type} authorization added and saved.`);
    },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'Could not save the authorization.', 'negative'),
  });
  const transition = useMutation({
    mutationFn: ({ auth, target, reason }) => transitionServiceAuthorization(clientId, auth.id, target, reason),
    onSuccess: (saved, vars) => { upsert(saved); invalidate(); setReview(null); toast.push(`Authorization ${STATUS_LABEL[vars.target].toLowerCase()}.`); },
    onError: (e) => { setReview(null); toast.push(e?.response?.data?.error?.message ?? 'That change isn’t allowed right now.', 'negative'); },
  });
  const del = useMutation({
    mutationFn: (auth) => archiveServiceAuthorization(clientId, auth.id),
    onSuccess: () => { invalidate(); setDeleting(null); toast.push('Authorization archived.'); },
    onError: (e) => { setDeleting(null); toast.push(e?.response?.data?.error?.message ?? 'Could not archive the authorization.', 'negative'); },
  });

  if (query.isLoading) return <Spinner />;
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />;
  const all = query.data ?? [];

  return (
    <>
      <div className="rx-stack" style={{ gap: 18 }}>
        {TYPES.map(({ type, label }) => {
          const auths = all.filter((a) => a.serviceType === type);
          return (
            <Card key={type} title={label} hint={auths.length ? `${auths.length} on file` : 'None yet'}
              action={<Button variant={auths.length ? 'subtle' : 'primary'} icon={Icon.Plus} onClick={() => setEditing({ type })}>Add {type}</Button>}>
              {auths.length === 0 ? (
                <EmptyState icon={Icon.Shield} title={`No ${type} authorization`} body={`Add a ${type} authorization — it is saved as soon as you add it. Sending it to the payer is a separate, optional step.`} />
              ) : (
                <div className="rx-stack" style={{ gap: 14 }}>
                  {auths.map((auth) => (
                    <AuthCard key={auth.id} auth={auth}
                      onEdit={() => setEditing({ type, auth })}
                      onReview={(target) => setReview({ auth, target })}
                      onDelete={() => setDeleting(auth)} />
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {editing && <AuthorizationEditor state={editing} busy={save.isPending}
        onCancel={() => setEditing(null)}
        onSave={(body) => save.mutate({ type: editing.type, auth: editing.auth, body })} />}

      <ReviewDialog review={review} busy={transition.isPending}
        onCancel={() => setReview(null)}
        onConfirm={(reason) => transition.mutate({ auth: review.auth, target: review.target, reason })} />

      <Confirm open={!!deleting} title="Archive authorization?" tone="danger" confirmLabel="Archive" busy={del.isPending}
        message={deleting ? `Archive ${deleting.serviceType} authorization${deleting.authorizationNumber ? ` #${deleting.authorizationNumber}` : ''}? Other authorizations for this child are unaffected.` : ''}
        onCancel={() => setDeleting(null)} onConfirm={() => deleting && del.mutate(deleting)} />
    </>
  );
}

/** One authorization record — its own status, units, transitions and actions. */
function AuthCard({ auth, onEdit, onReview, onDelete }) {
  return (
    <div style={{ border: '1px solid var(--rx-line)', borderRadius: 14, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Badge tone="info">Saved</Badge>
          <span className="rx-row__meta">Payer</span>
          <Badge status={auth.status}>{STATUS_LABEL[auth.status]}</Badge>
          {auth.authorizationNumber && <span className="rx-row__meta">#{auth.authorizationNumber}</span>}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button variant="ghost" icon={Icon.Clipboard} onClick={onEdit}>Edit</Button>
          <Button variant="ghost" aria-label="Archive authorization" onClick={onDelete}><Icon.Logout size={16} /></Button>
        </div>
      </div>
      <div className="rx-list">
        <Row label="Effective dates" value={auth.startDate || auth.endDate ? `${fmtDate(auth.startDate) || '—'} → ${fmtDate(auth.endDate) || '—'}` : null} />
        {auth.units != null ? (
          <div className="rx-row" style={{ display: 'block', padding: '8px 0' }}>
            <div className="rx-row__meta" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span>{auth.units} authorized · {auth.usedUnits ?? 0} used · <strong>{auth.remainingUnits ?? auth.units} remaining</strong></span>
              <span>{auth.hours != null ? `${auth.hours} hrs` : ''}</span>
            </div>
            <div style={{ height: 6, borderRadius: 999, background: 'var(--rx-line-soft, #eee)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${auth.units > 0 ? Math.min(100, Math.round(((auth.usedUnits ?? 0) / auth.units) * 100)) : 0}%`, background: 'var(--rx-accent-strong, #0D5E87)' }} />
            </div>
          </div>
        ) : null}
        <Row label="Billing code" value={auth.billingCode} />
        {auth.comments && <Row label="Comments" value={auth.comments} />}
      </div>
      {(NEXT[auth.status] || []).length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }} aria-label="Payer review">
          <span className="rx-row__meta" style={{ marginRight: 4 }}>Payer review (optional)</span>
          {NEXT[auth.status].map((t) => (
            <Button key={t} variant={t === 'DENIED' ? 'ghost' : 'subtle'} onClick={() => onReview(t)}>
              {t === 'SENT' ? 'Mark sent' : t === 'APPROVED' ? 'Review & approve' : 'Deny'}
            </Button>
          ))}
        </div>
      )}
      {auth.history?.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--rx-ink-soft)', fontSize: '.85rem' }}>History ({auth.history.length})</summary>
          <div className="rx-list" style={{ marginTop: 8 }}>
            <AnimatePresence>
              {[...auth.history].reverse().map((h, i) => (
                <motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rx-row">
                  <div className="rx-row__main">
                    <div className="rx-row__title">{STATUS_LABEL[h.from]} → {STATUS_LABEL[h.to]}</div>
                    <div className="rx-row__meta">{h.at ? formatDateTime(h.at) : ''}{h.reason ? ` · ${h.reason}` : ''}</div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </details>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return <div className="rx-row"><div className="rx-row__main"><div className="rx-row__meta">{label}</div><div className="rx-row__title">{orNP(value)}</div></div></div>;
}

function AuthorizationEditor({ state, onCancel, onSave, busy }) {
  const a = state.auth || {};
  const isNew = !state.auth;
  const [form, setForm] = useState({
    authorizationNumber: a.authorizationNumber ?? '', billingCode: a.billingCode ?? '',
    // A brand-new authorization defaults Start Date to TODAY (dynamic, local
    // calendar day — never hardcoded). Editing keeps the record's stored date.
    startDate: a.startDate ? String(a.startDate).slice(0, 10) : (isNew ? todayLocalISO() : ''),
    endDate: a.endDate ? String(a.endDate).slice(0, 10) : '',
    units: a.units ?? '', hours: a.hours ?? '', comments: a.comments ?? '',
  });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    if (form.startDate && form.endDate && form.endDate < form.startDate) { setErr('The end date must be on or after the start date.'); return; }
    const body = {};
    for (const k of ['authorizationNumber', 'billingCode', 'startDate', 'endDate', 'comments']) if (String(form[k]).trim() !== '') body[k] = form[k];
    if (String(form.units).trim() !== '') body.units = Number(form.units);
    setErr(''); onSave(body);
  }

  return (
    <Modal open onClose={onCancel} variant="drawer" title={`${state.auth ? 'Edit' : 'Add'} ${state.type} authorization`}
      description={isNew
        ? 'Adding saves the authorization immediately and it can be used right away. Sending it to the payer and approval are tracked separately.'
        : 'Changes are saved immediately. The payer review status is not changed by editing.'}
      footer={<><Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button><Button onClick={submit} loading={busy} icon={isNew ? Icon.Plus : Icon.Check}>{isNew ? 'Add authorization' : 'Save changes'}</Button></>}>
      <Field label="Authorization number"><TextInput value={form.authorizationNumber} onChange={set('authorizationNumber')} icon={Icon.Shield} /></Field>
      <Field label="Billing code" hint="Service/CPT code for this authorization"><TextInput value={form.billingCode} onChange={set('billingCode')} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Start date" hint="MM/DD/YYYY"><DateInput value={form.startDate} onChange={set('startDate')} aria-label="Start date" /></Field>
        <Field label="End date" hint="MM/DD/YYYY"><DateInput value={form.endDate} onChange={set('endDate')} aria-label="End date" /></Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Units" hint="1 unit = 15 min"><TextInput type="number" min="0" value={form.units} onChange={set('units')} /></Field>
        <Field label="Hours (derived)"><TextInput type="text" value={form.units !== '' && !Number.isNaN(Number(form.units)) ? String(Math.round((Number(form.units) * 15) / 60 * 100) / 100) : '—'} readOnly disabled /></Field>
      </div>
      <Field label="Comments"><Textarea value={form.comments} onChange={set('comments')} rows={3} /></Field>
      {err && <p className="rx-formfield__err">{err}</p>}
    </Modal>
  );
}

function ReviewDialog({ review, onCancel, onConfirm, busy }) {
  const [reason, setReason] = useState('');
  if (!review) return null;
  const { auth, target } = review;
  const isDeny = target === 'DENIED';
  const isApprove = target === 'APPROVED';
  // Simple sent/deny use a confirm; approve/deny show the review detail + reason.
  if (target === 'SENT') {
    return <Confirm open title="Mark as sent" message={`Mark this ${auth.serviceType} authorization as sent to the payer?`} confirmLabel="Mark sent" busy={busy} onCancel={onCancel} onConfirm={() => onConfirm()} />;
  }
  return (
    <Modal open onClose={onCancel} title={`${isApprove ? 'Approve' : 'Deny'} ${auth.serviceType} authorization`} size="sm"
      description="Review the authorization before recording the decision."
      footer={<><Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant={isDeny ? 'danger' : 'primary'} loading={busy} disabled={isDeny && !reason.trim()} onClick={() => onConfirm(reason.trim() || undefined)}>{isApprove ? 'Approve' : 'Deny'}</Button></>}>
      <div className="rx-list" style={{ marginBottom: 12 }}>
        <Row label="Authorization number" value={auth.authorizationNumber} />
        <Row label="Effective dates" value={auth.startDate || auth.endDate ? `${fmtDate(auth.startDate) || '—'} → ${fmtDate(auth.endDate) || '—'}` : null} />
        <Row label="Units / hours" value={[auth.units != null ? `${auth.units} units` : null, auth.hours != null ? `${auth.hours} hrs` : null].filter(Boolean).join(' · ') || null} />
        <Row label="Billing code" value={auth.billingCode} />
      </div>
      {isDeny && <Field label="Reason" required hint="Required to deny"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} /></Field>}
    </Modal>
  );
}

export default AuthorizationsPanel;
