import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { fetchCoverage, createCoverage, updateCoverage, removeCoverage, verifyCoverage, listInsuranceCatalog } from '@/api/client';
import { useToast } from '@/components';
import { Card, Button, Badge, Icon, Spinner, ErrorState, EmptyState, Modal, Confirm, Field, TextInput, Select } from '@/ui';
import { formatDate, formatDateTime } from '@/lib/format';
import { usStateName } from '@aba1on1/schemas';

/**
 * Insurance — coverage records with a clear verification state.
 *
 * Module 5: the "Insurance company" is chosen from the platform master catalog
 * filtered to the company's service states (name + logo), OR entered as "Other
 * insurance" free text (spec 5.4/5.5). When a company already has coverage on
 * file, each record offers Edit and Delete — not just Add (spec 5.6); Add stays
 * available because the model supports primary/secondary/tertiary.
 *
 * SAVING ACTIVATES. "Add insurance" / "Save changes" persists the coverage and
 * the SERVER records it as VERIFIED (active) in the same request — there is no
 * separate manual verification step before scheduling and insurance billing
 * can use it. The Verify action remains only for an older record that was
 * saved before this rule (still unverified).
 */
const STATUS_TONE = { VERIFIED: 'approved', UNVERIFIED: 'pending', PENDING: 'pending', EXPIRED: 'denied', FAILED: 'denied' };
const REL_OPTS = [{ value: 'SELF', label: 'Self' }, { value: 'PARENT', label: 'Parent' }, { value: 'GUARDIAN', label: 'Guardian' }, { value: 'SPOUSE', label: 'Spouse' }, { value: 'OTHER', label: 'Other' }];
// Plan Name, Benefit Order and Funding Source were removed from this form
// (spec Fix 2). They are no longer part of the create/edit state or payload.
const BLANK = { payerName: '', catalogInsuranceId: '', memberId: '', groupNumber: '', subscriberRelationship: 'PARENT', subscriberName: '' };

export function InsurancePanelRedesign({ clientId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canEdit = permissions.includes('clients.update');

  const query = useQuery({ queryKey: ['coverage', clientId], queryFn: () => fetchCoverage(clientId) });
  const [editing, setEditing] = useState(null); // null | {} (new) | full record (edit)
  const [verifying, setVerifying] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // Coverage feeds this panel, the client record/roster and the child alerts.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['coverage', clientId] });
    qc.invalidateQueries({ queryKey: ['client', clientId] });
    qc.invalidateQueries({ queryKey: ['clients'] });
    qc.invalidateQueries({ queryKey: ['child-alerts', clientId] });
  };
  // Show the server's saved record immediately, then refetch to stay authoritative.
  const upsert = (saved) => {
    if (!saved?.id) return;
    qc.setQueryData(['coverage', clientId], (cur) => {
      if (!cur || !Array.isArray(cur.items)) return cur;
      const items = cur.items.some((c) => c.id === saved.id) ? cur.items.map((c) => (c.id === saved.id ? { ...c, ...saved } : c)) : [...cur.items, saved];
      return { ...cur, items };
    });
  };
  const verifyMut = useMutation({
    mutationFn: ({ coverageId }) => verifyCoverage(clientId, coverageId, { status: 'VERIFIED' }),
    onSuccess: (saved) => { upsert(saved); invalidate(); toast.push('Coverage verified.'); setVerifying(null); },
    onError: () => { toast.push('Could not record verification.', 'negative'); setVerifying(null); },
  });
  const deleteMut = useMutation({
    mutationFn: (coverageId) => removeCoverage(clientId, coverageId),
    onSuccess: () => { invalidate(); toast.push('Insurance removed.'); setDeleting(null); },
    onError: () => { toast.push('Could not remove insurance.', 'negative'); setDeleting(null); },
  });

  if (query.isLoading) return <Spinner />;
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />;
  const items = query.data?.items ?? [];
  const hasCoverage = items.length > 0;

  return (
    <Card
      title="Insurance"
      hint={hasCoverage ? 'One insurance on file — edit or remove it below.' : 'Add insurance from your state catalog, or enter other insurance.'}
      action={canEdit && !hasCoverage && <Button icon={Icon.Plus} variant="primary" onClick={() => setEditing({})}>Add insurance</Button>}
    >
      {!hasCoverage ? (
        <EmptyState icon={Icon.Shield} title="No insurance recorded" body="Add insurance to run eligibility verification and enable scheduling."
          action={canEdit && <Button icon={Icon.Plus} onClick={() => setEditing({})}>Add insurance</Button>} />
      ) : (
        <div className="rx-stack" style={{ gap: 14 }}>
          {items.map((c) => {
            const tone = STATUS_TONE[c.verificationStatus] || 'pending';
            const history = c.verificationHistory || c.history || [];
            return (
              <motion.div key={c.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                style={{ border: '1px solid var(--rx-line)', borderRadius: 14, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 680, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                      {c.logoUrl ? <img src={c.logoUrl} alt="" width={22} height={22} style={{ borderRadius: 4, objectFit: 'contain' }} /> : null}
                      <span>{c.payerName}</span>
                      {c.catalogInsuranceId ? null : <span style={{ color: 'var(--rx-ink-faint)', fontWeight: 400, fontSize: '.8rem' }}> · Other</span>}
                    </div>
                    <div className="rx-row__meta" style={{ marginTop: 4 }}>
                      Member {c.memberId}{c.groupNumber ? ` · Group ${c.groupNumber}` : ''}
                    </div>
                    {(c.effectiveFrom || c.effectiveTo) && (
                      <div className="rx-row__meta">Effective {c.effectiveFrom ? formatDate(c.effectiveFrom) : '—'}{c.effectiveTo ? ` – ${formatDate(c.effectiveTo)}` : ''}</div>
                    )}
                    {c.verificationFailureReason && <p className="rx-formfield__err" style={{ marginTop: 6 }}>{c.verificationFailureReason}</p>}
                  </div>
                  <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <Badge tone="info">Saved</Badge>
                      <Badge tone={tone}>{(c.verificationStatus || 'UNVERIFIED').toLowerCase()}</Badge>
                    </div>
                    {c.verifiedAt && <span className="rx-row__meta">Verified {formatDate(c.verifiedAt)}</span>}
                    {canEdit && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        {c.verificationStatus !== 'VERIFIED' && <Button variant="ghost" icon={Icon.Check} onClick={() => setVerifying(c)}>Verify</Button>}
                        <Button variant="ghost" aria-label="Edit insurance" onClick={() => setEditing(c)}><Icon.Clipboard size={16} /></Button>
                        <Button variant="ghost" aria-label="Delete insurance" onClick={() => setDeleting(c)}><Icon.Logout size={16} /></Button>
                      </div>
                    )}
                  </div>
                </div>
                {history.length > 0 && (
                  <div style={{ marginTop: 12, borderTop: '1px solid var(--rx-line-soft)', paddingTop: 10 }}>
                    <div className="rx-card__hint" style={{ marginBottom: 6 }}>Verification history</div>
                    <div className="rx-list">
                      {history.slice(0, 5).map((h, i) => (
                        <div className="rx-row" key={i} style={{ padding: '6px 0' }}>
                          <Icon.Clock size={14} />
                          <div className="rx-row__main"><div className="rx-row__title" style={{ fontSize: '0.82rem' }}>{h.status || h.action}</div>
                            <div className="rx-row__meta">{h.at ? formatDateTime(h.at) : ''}{h.by ? ` · ${h.by}` : ''}</div></div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}

      {editing && canEdit && (
        <InsuranceEditor
          clientId={clientId}
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => { upsert(saved); invalidate(); setEditing(null); }}
        />
      )}

      <Confirm open={!!verifying} title="Record insurance verification"
        message={verifying ? `Confirm you checked coverage with ${verifying.payerName} and it is active for this child. This is what allows services to be scheduled.` : ''}
        confirmLabel="Coverage is active" busy={verifyMut.isPending}
        onCancel={() => setVerifying(null)} onConfirm={() => verifying && verifyMut.mutate({ coverageId: verifying.id })} />

      <Confirm open={!!deleting} title="Remove insurance?" tone="danger" confirmLabel="Remove" busy={deleteMut.isPending}
        message={deleting ? `Remove ${deleting.payerName} from this client? This removes the coverage record and its verification history.` : ''}
        onCancel={() => setDeleting(null)} onConfirm={() => deleting && deleteMut.mutate(deleting.id)} />
    </Card>
  );
}

function InsuranceEditor({ clientId, record, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = Boolean(record?.id);
  // Normalize the record into the controlled-input shape. The API returns null
  // for optional fields it has no value for (groupNumber, subscriberName, …), so
  // spreading the record raw would put `value={null}` on a controlled input —
  // React's uncontrolled→controlled warning (spec Part 29), and worse, a later
  // `form.groupNumber.trim()` throws TypeError on null and the save silently
  // fails before the request is ever sent. Coerce every string field to '' here
  // so the inputs stay controlled and Save can never crash on a null.
  const [form, setForm] = useState({
    ...BLANK,
    ...record,
    payerName: record?.payerName ?? '',
    memberId: record?.memberId ?? '',
    groupNumber: record?.groupNumber ?? '',
    subscriberName: record?.subscriberName ?? '',
    subscriberRelationship: record?.subscriberRelationship ?? 'PARENT',
    catalogInsuranceId: record?.catalogInsuranceId ?? '',
  });
  // "Other insurance" mode: free-text payer instead of a catalog pick. Default to
  // Other when editing a record that had no catalog link but has a payer name.
  const [other, setOther] = useState(Boolean(record?.id && !record?.catalogInsuranceId && record?.payerName));
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: typeof v === 'string' ? v : v.target.value }));

  const catalog = useQuery({ queryKey: ['insurance-catalog'], queryFn: listInsuranceCatalog });
  // Options carry the Super-Admin-provided logo (image) where one exists — no
  // placeholder is invented for entries without a logo (spec Fix 2 "Insurance
  // logo"). Only ACTIVE, company-state-matched entries reach here (backend).
  const catalogOpts = (catalog.data ?? []).map((e) => ({ value: e.id, label: e.name, hint: (e.states || []).map(usStateName).join(', '), image: e.logoUrl || undefined }));
  const noCatalog = !catalog.isLoading && catalogOpts.length === 0;
  const selectedCatalog = (catalog.data ?? []).find((e) => e.id === form.catalogInsuranceId) || null;

  const chooseCatalog = (id) => {
    const entry = (catalog.data ?? []).find((e) => e.id === id);
    setForm((f) => ({ ...f, catalogInsuranceId: id, payerName: entry?.name ?? f.payerName }));
  };

  const save = useMutation({
    mutationFn: () => {
      // Plan Name, Benefit Order and Funding Source are intentionally NOT part of
      // this payload (spec Fix 2 "Insurance form cleanup"). The backend schema is
      // strict and would reject them anyway; they are simply not collected here.
      const body = {
        payerName: form.payerName.trim(),
        memberId: form.memberId.trim(),
        subscriberRelationship: form.subscriberRelationship,
        catalogInsuranceId: other ? null : (form.catalogInsuranceId || null),
        // Always send the optional fields (as trimmed value or null) so an edit
        // can both SET and CLEAR them. Omitting an emptied field on update would
        // leave the old value in place — an edit that appears to succeed but does
        // not persist the clear (spec Bug #2).
        groupNumber: form.groupNumber.trim() || null,
        subscriberName: form.subscriberName.trim() || null,
      };
      return isEdit ? updateCoverage(clientId, record.id, body) : createCoverage(clientId, body);
    },
    onSuccess: (saved) => { toast.push(isEdit ? 'Insurance updated.' : 'Insurance added and saved.'); onSaved(saved); },
    onError: (e) => toast.push(e?.response?.data?.error?.message ?? 'Could not save insurance. Check the fields and try again.', 'negative'),
  });

  const payerValid = form.payerName.trim().length > 0;
  const canSave = payerValid && form.memberId.trim().length > 0;

  return (
    <Modal open onClose={onClose} title={isEdit ? 'Edit insurance' : 'Add insurance'} description={isEdit ? 'Changes are saved and the insurance stays active.' : 'Adding saves the insurance and makes it active immediately.'} variant="drawer"
      footer={<><Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!canSave}>{isEdit ? 'Save changes' : 'Add insurance'}</Button></>}>
      {/* Insurance company: catalog pick (name + state) OR Other free text (5.4/5.5) */}
      {!other && !noCatalog ? (
        <Field label="Insurance company" required hint="From your state’s catalog">
          <Select value={form.catalogInsuranceId} onChange={chooseCatalog} options={catalogOpts} loading={catalog.isLoading} placeholder="Select insurance…" emptyText="No catalog insurers for your state" />
        </Field>
      ) : (
        <Field label="Insurance company (other)" required>
          <TextInput value={form.payerName} onChange={set('payerName')} icon={Icon.Shield} placeholder="Enter insurer name" />
        </Field>
      )}
      {!noCatalog && (
        <button type="button" className="rx-linkbtn" style={{ background: 'none', border: 'none', color: 'var(--rx-accent-strong)', cursor: 'pointer', padding: '2px 0', fontSize: '.82rem' }}
          onClick={() => { setOther((o) => !o); setForm((f) => ({ ...f, catalogInsuranceId: '' })); }}>
          {other ? '← Choose from catalog instead' : '+ Add other insurance (not in catalog)'}
        </button>
      )}

      {/* Show the Super-Admin catalog logo for the chosen insurer, where one
          exists. No placeholder is shown for entries without a logo. */}
      {!other && selectedCatalog?.logoUrl ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 10px' }}>
          <img src={selectedCatalog.logoUrl} alt="" width={28} height={28} style={{ borderRadius: 6, objectFit: 'contain' }} />
          <span className="rx-row__meta">{selectedCatalog.name}</span>
        </div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Member ID" required><TextInput value={form.memberId} onChange={set('memberId')} /></Field>
        <Field label="Group number"><TextInput value={form.groupNumber} onChange={set('groupNumber')} /></Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="Subscriber relationship"><Select value={form.subscriberRelationship} onChange={set('subscriberRelationship')} options={REL_OPTS} searchable={false} /></Field>
        <Field label="Subscriber name"><TextInput value={form.subscriberName} onChange={set('subscriberName')} /></Field>
      </div>
    </Modal>
  );
}

export default InsurancePanelRedesign;
