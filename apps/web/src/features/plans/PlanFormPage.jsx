import { useEffect, useState } from 'react';
import { formatFullName } from '@/lib/format';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createPlan, getPlan, listClients, listStaff, updatePlan } from '@/api/client';
import { Button, Card, LoadingState, ErrorState } from '@/components';
import { DateInput } from '@/ui';

const EMPTY = { clientId: '', title: '', responsibleBcbaStaffId: '', status: 'DRAFT', effectiveDate: '', reviewDate: '', notes: '' };

/**
 * Create a new treatment plan or edit an existing one. Client and responsible
 * BCBA are chosen from live lists; the server enforces that the client is ACTIVE
 * and the BCBA is active staff, and refuses edits to an archived plan. Edit
 * submits a versioned If-Match update.
 */
export function PlanFormPage() {
  const { planId } = useParams();
  const isEdit = Boolean(planId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [form, setForm] = useState(EMPTY);
  const [version, setVersion] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const clients = useQuery({ queryKey: ['clients', { limit: 100 }], queryFn: () => listClients({ limit: 100 }) });
  const staff = useQuery({ queryKey: ['staff', { limit: 100 }], queryFn: () => listStaff({ limit: 100 }) });
  const detail = useQuery({ queryKey: ['plan', planId], queryFn: () => getPlan(planId), enabled: isEdit });

  useEffect(() => {
    if (!isEdit || !detail.data) return;
    const p = detail.data.plan;
    setForm({
      clientId: p.clientId, title: p.title ?? '', responsibleBcbaStaffId: p.responsibleBcbaStaffId ?? '',
      status: p.status === 'ARCHIVED' ? 'ARCHIVED' : p.status,
      effectiveDate: p.effectiveDate ? String(p.effectiveDate).slice(0, 10) : '',
      reviewDate: p.reviewDate ? String(p.reviewDate).slice(0, 10) : '',
      notes: p.notes ?? '',
    });
    setVersion(p.version);
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
        for (const key of ['title', 'responsibleBcbaStaffId', 'effectiveDate', 'reviewDate', 'notes']) {
          if (form[key].trim && form[key].trim()) body[key] = form[key].trim();
          else if (form[key]) body[key] = form[key];
        }
        if (form.status === 'DRAFT' || form.status === 'ACTIVE') body.status = form.status;
        result = await updatePlan(planId, body, version);
      } else {
        const body = { clientId: form.clientId, title: form.title.trim(), responsibleBcbaStaffId: form.responsibleBcbaStaffId };
        for (const key of ['effectiveDate', 'reviewDate', 'notes']) {
          if (form[key].trim()) body[key] = form[key].trim();
        }
        result = await createPlan(body);
      }
      await queryClient.invalidateQueries({ queryKey: ['plans'] });
      if (isEdit) await queryClient.invalidateQueries({ queryKey: ['plan', planId] });
      navigate(`/plans/${result.id}`);
    } catch (err) {
      setError(err?.response?.data?.error?.message ?? 'Could not save the plan.');
      setSaving(false);
    }
  };

  if (isEdit && detail.isLoading) return <LoadingState label="Loading plan…" />;
  if (isEdit && detail.isError) return <ErrorState message="Could not load the plan." onRetry={() => detail.refetch()} />;

  return (
    <div className="ui-stack">
      <h1>{isEdit ? 'Edit plan' : 'New treatment plan'}</h1>
      <Card>
        <form onSubmit={submit}>
          <div className="ui-fields">
            <label className="field"><span>Client</span>
              <select className="input" value={form.clientId} onChange={set('clientId')} disabled={isEdit} required>
                <option value="">Select…</option>
                {(clients.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{formatFullName(c)}</option>)}
              </select>
            </label>
            <label className="field"><span>Responsible BCBA</span>
              <select className="input" value={form.responsibleBcbaStaffId} onChange={set('responsibleBcbaStaffId')} required>
                <option value="">Select…</option>
                {(staff.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{formatFullName(s)}</option>)}
              </select>
            </label>
            <label className="field"><span>Title</span><input className="input" value={form.title} onChange={set('title')} required /></label>
            {isEdit ? (
              <label className="field"><span>Status</span>
                <select className="input" value={form.status} onChange={set('status')} disabled={form.status === 'ARCHIVED'}>
                  <option value="DRAFT">DRAFT</option>
                  <option value="ACTIVE">ACTIVE</option>
                  {form.status === 'ARCHIVED' ? <option value="ARCHIVED">ARCHIVED</option> : null}
                </select>
              </label>
            ) : null}
            <label className="field"><span>Effective date</span><DateInput value={form.effectiveDate} onChange={set('effectiveDate')} aria-label="Effective date" /></label>
            <label className="field"><span>Review date</span><DateInput value={form.reviewDate} onChange={set('reviewDate')} aria-label="Review date" /></label>
            <label className="field"><span>Notes</span><input className="input" value={form.notes} onChange={set('notes')} /></label>
          </div>

          {error !== null ? <p className="form-error" role="alert">{error}</p> : null}

          <div className="ui-row">
            <button type="submit" className="ui-button" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <Button variant="ghost" type="button" onClick={() => navigate(isEdit ? `/plans/${planId}` : '/plans')}>Cancel</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
