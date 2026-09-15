import { useEffect, useState } from 'react';
import { formatFullName } from '@/lib/format';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { createPlan, getPlan, updatePlan, listClients } from '@/api/client';
import { useToast } from '@/components';
import { PageHeader, Card, Button, Icon, Badge, Field, TextInput, DateInput, Textarea, Select, Spinner, ErrorState } from '@/ui';

/**
 * Treatment plan create/edit. Real APIs; edits use the If-Match version the
 * server returns (getPlan → updatePlan(version)) so concurrent edits are caught
 * rather than silently overwritten. Fields follow the backend contract — nothing
 * invented. On CREATE the server auto-activates the plan (spec Part 1): the
 * create body never sends a status, and the new plan comes back ACTIVE. The
 * Status control below is EDIT-only, where DRAFT<->ACTIVE is a guarded
 * lifecycle transition.
 */
const EMPTY = { clientId: '', title: '', status: 'DRAFT', effectiveDate: '', reviewDate: '', notes: '' };
const STATUS_OPTS = [{ value: 'DRAFT', label: 'Draft' }, { value: 'ACTIVE', label: 'Active' }];

export function PlanEditorRedesign() {
  const { planId } = useParams();
  const isEdit = Boolean(planId);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // When the editor is opened from a Child Profile (New/Create treatment plan),
  // the child is carried on the URL as ?clientId=… so the plan is created for
  // THAT child. The field is locked to preserve the context; the server still
  // re-validates the clientId against the tenant and the caller's scope on
  // createPlan, so the query param is a convenience, never the authority.
  const presetClientId = !isEdit ? (searchParams.get('clientId') || '') : '';
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState({ ...EMPTY, clientId: presetClientId });
  const [version, setVersion] = useState(null);
  const [errors, setErrors] = useState({});
  const set = (key) => (v) => setForm((f) => ({ ...f, [key]: typeof v === 'string' ? v : v.target.value }));

  const existing = useQuery({ queryKey: ['plan', planId], queryFn: () => getPlan(planId), enabled: isEdit });
  const clients = useQuery({ queryKey: ['clients', 'opts'], queryFn: () => listClients({}) });

  useEffect(() => {
    if (existing.data) {
      // getPlan resolves { plan, goals }; the editable fields live on `plan`.
      const p = existing.data.plan ?? existing.data;
      setForm({
        clientId: p.clientId, title: p.title ?? '',
        status: p.status === 'ARCHIVED' ? 'ARCHIVED' : p.status,
        effectiveDate: p.effectiveDate ? String(p.effectiveDate).slice(0, 10) : '',
        reviewDate: p.reviewDate ? String(p.reviewDate).slice(0, 10) : '', notes: p.notes ?? '',
      });
      setVersion(p.version);
    }
  }, [existing.data]);

  const clientOpts = (clients.data?.items ?? []).map((c) => ({ value: c.id, label: formatFullName(c) }));

  const save = useMutation({
    mutationFn: () => {
      if (isEdit) {
        const body = {};
        for (const k of ['title', 'effectiveDate', 'reviewDate', 'notes']) if (form[k]) body[k] = form[k];
        if (form.status === 'DRAFT' || form.status === 'ACTIVE') body.status = form.status;
        return updatePlan(planId, body, version);
      }
      const body = { clientId: form.clientId, title: form.title.trim() };
      for (const k of ['effectiveDate', 'reviewDate', 'notes']) if (form[k]?.trim?.()) body[k] = form[k].trim();
      return createPlan(body);
    },
    onSuccess: (result) => { qc.invalidateQueries({ queryKey: ['plans'] }); qc.invalidateQueries({ queryKey: ['plan', result.id ?? planId] }); toast.push(isEdit ? 'Plan updated.' : 'Treatment Plan created and activated.'); navigate(`/plans/${result.id ?? planId}`); },
    onError: (err) => {
      const status = err?.response?.status;
      const apiError = err?.response?.data?.error; // { code, message, details? }
      let submit;
      if (status === 412) {
        submit = 'This plan changed since you opened it. Reload and reapply your edits.';
      } else if (apiError?.details?.fieldErrors || apiError?.details?.formErrors) {
        // Zod validation (422): surface the first concrete field/form message
        // rather than a blanket "check the required fields".
        const fieldErrors = apiError.details.fieldErrors || {};
        const firstField = Object.values(fieldErrors).flat().find(Boolean);
        const firstForm = (apiError.details.formErrors || []).find(Boolean);
        submit = firstField || firstForm || 'Please check the highlighted fields and try again.';
      } else if (apiError?.message && apiError.code !== 'VALIDATION_FAILED') {
        // Service-level, plain-language reason — e.g. "Only active clients may
        // have a treatment plan." or "The responsible BCBA must be an active
        // staff member." The API already returns a user-safe message; show it,
        // instead of telling the BCBA to fix a form field that is actually fine.
        submit = apiError.message;
      } else {
        submit = 'Could not save the plan. Check the required fields and try again.';
      }
      setErrors({ submit });
    },
  });

  function submit() {
    const e = {};
    if (!isEdit && !form.clientId) e.clientId = 'Choose the child this plan is for.';
    if (!form.title.trim()) e.title = 'A plan title is required.';
    setErrors(e);
    if (Object.keys(e).length === 0) save.mutate();
  }

  if (isEdit && existing.isLoading) return <Spinner />;
  if (isEdit && existing.isError) return <ErrorState onRetry={() => existing.refetch()} />;

  return (
    <>
      <PageHeader eyebrow="Treatment planning" title={isEdit ? 'Edit treatment plan' : 'New treatment plan'}
        subtitle="Define who the plan is for, who owns it, and its clinical timeline."
        actions={isEdit && form.status ? <Badge status={form.status} /> : null} />

      <div className="rx-cols-2">
        <Card title="Plan details">
          {!isEdit && (
            <Field label="Child" required error={errors.clientId}>
              <Select value={form.clientId} onChange={set('clientId')} options={clientOpts} loading={clients.isLoading} placeholder="Select a child…" disabled={Boolean(presetClientId)} />
            </Field>
          )}
          <Field label="Plan title" required error={errors.title}><TextInput value={form.title} onChange={set('title')} placeholder="e.g. Q3 Behavior Support Plan" icon={Icon.Clipboard} /></Field>
          {isEdit && <Field label="Status"><Select value={form.status} onChange={set('status')} options={STATUS_OPTS} searchable={false} /></Field>}
        </Card>

        <Card title="Timeline & notes">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Effective date" hint="MM/DD/YYYY"><DateInput value={form.effectiveDate} onChange={set('effectiveDate')} aria-label="Effective date" /></Field>
            <Field label="Review date" hint="MM/DD/YYYY"><DateInput value={form.reviewDate} onChange={set('reviewDate')} aria-label="Review date" /></Field>
          </div>
          <Field label="Notes"><Textarea value={form.notes} onChange={set('notes')} rows={5} placeholder="Clinical context, goals summary…" /></Field>
        </Card>
      </div>

      {errors.submit && <p className="rx-formfield__err" style={{ marginTop: 14 }}>{errors.submit}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <Button variant="ghost" onClick={() => navigate(isEdit ? `/plans/${planId}` : '/plans')}>Cancel</Button>
        <Button onClick={submit} loading={save.isPending} icon={Icon.Check}>{isEdit ? 'Save changes' : 'Create plan'}</Button>
      </div>
    </>
  );
}

export default PlanEditorRedesign;
