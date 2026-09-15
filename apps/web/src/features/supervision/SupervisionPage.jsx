import { formatDateTime } from '@/lib/format';
import { usePermissions } from '@/auth/permissions';
import { formatWorkedTime } from '@/features/sessions/useSessionTimer.js';
import { useState } from 'react';
import { DateInput } from '@/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listSupervisionObservations, createSupervisionObservation,
  submitSupervisionObservation, signSupervisionObservation,
  getSupervisionHoursSummary,
} from '@/api/client';
import { Card, Button, StatusBadge, LoadingState, ErrorState, EmptyState, ConfirmDialog, useToast } from '@/components';

/**
 * Supervision workflow: log observations, move them through the
 * DRAFT → SUBMITTED → SIGNED lifecycle, and review supervision-hour totals.
 * Creating/submitting requires supervision.log; signing requires
 * supervision.signoff. The backend is authoritative for every gate and for the
 * signer identity/timestamp — the UI only mirrors the permissions.
 */
export function SupervisionPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canLog = permissions.includes('supervision.log');
  const canSign = permissions.includes('supervision.signoff');

  const [confirm, setConfirm] = useState(null); // { obs, action }
  const [form, setForm] = useState({ supervisorStaffId: '', superviseeStaffId: '', observedAt: '', durationMinutes: '', method: 'IN_PERSON', summary: '' });

  const observations = useQuery({ queryKey: ['supervision-observations'], queryFn: () => listSupervisionObservations() });
  const hours = useQuery({ queryKey: ['supervision-hours'], queryFn: () => getSupervisionHoursSummary() });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['supervision-observations'] });
    qc.invalidateQueries({ queryKey: ['supervision-hours'] });
  };

  const createMut = useMutation({
    mutationFn: () => createSupervisionObservation({
      supervisorStaffId: form.supervisorStaffId.trim(),
      superviseeStaffId: form.superviseeStaffId.trim(),
      observedAt: new Date(form.observedAt).toISOString(),
      durationMinutes: Number(form.durationMinutes),
      method: form.method,
      summary: form.summary.trim() || undefined,
    }),
    onSuccess: () => { invalidate(); setForm({ supervisorStaffId: '', superviseeStaffId: '', observedAt: '', durationMinutes: '', method: 'IN_PERSON', summary: '' }); toast.push('Observation created.'); },
    onError: (err) => toast.push(err?.response?.data?.error?.message ?? 'Could not create observation.', 'negative'),
  });

  const workflowMut = useMutation({
    mutationFn: ({ obs, action }) => (action === 'submit' ? submitSupervisionObservation(obs.id) : signSupervisionObservation(obs.id)),
    onSuccess: () => { invalidate(); setConfirm(null); toast.push('Observation updated.'); },
    onError: (err) => { setConfirm(null); toast.push(err?.response?.data?.error?.message ?? 'Could not update observation.', 'negative'); },
  });

  const canCreate = canLog && form.supervisorStaffId && form.superviseeStaffId && form.observedAt && Number(form.durationMinutes) > 0;

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>Supervision</h1>
      </div>

      <Card>
        <h2>Supervision hours</h2>
        {hours.isLoading ? <LoadingState label="Loading hours…" /> : null}
        {hours.isError ? <ErrorState message="Could not load hours." onRetry={() => hours.refetch()} /> : null}
        {hours.data ? (
          <div className="ui-stack" style={{ gap: '0.25rem' }}>
            {/* Hours and minutes, not a raw minute count — a reader should not
                have to divide by 60 to know how much time this is. */}
            <p><strong>{formatWorkedTime(hours.data.totalMinutes)}</strong> total across {hours.data.entries.length} entries.</p>
            {hours.data.bySupervisee.length ? (
              <ul>
                {hours.data.bySupervisee.map((s) => (
                  <li key={s.superviseeStaffId} className="muted">Supervisee {s.superviseeStaffId}: {s.totalHours}h ({s.entries} entries)</li>
                ))}
              </ul>
            ) : <p className="muted">No supervision hours recorded yet.</p>}
          </div>
        ) : null}
      </Card>

      {canLog ? (
        <Card>
          <h2>Log an observation</h2>
          <div className="ui-stack" style={{ gap: '0.5rem' }}>
            <input placeholder="Supervisor staff ID" value={form.supervisorStaffId} onChange={(e) => setForm({ ...form, supervisorStaffId: e.target.value })} />
            <input placeholder="Supervisee staff ID" value={form.superviseeStaffId} onChange={(e) => setForm({ ...form, superviseeStaffId: e.target.value })} />
            {/* Observed at: the same "YYYY-MM-DDTHH:mm" wall-clock value the
                datetime-local field produced, edited as the shared MM/DD/YYYY
                date picker + a time field (never locale-formatted text). */}
            <div className="ui-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 12rem' }}>
                <DateInput aria-label="Observed date" value={form.observedAt.slice(0, 10)}
                  onChange={(e) => setForm((f) => ({ ...f, observedAt: e.target.value ? `${e.target.value}T${f.observedAt.slice(11, 16) || '00:00'}` : '' }))} />
              </div>
              <input type="time" aria-label="Observed time" value={form.observedAt.slice(11, 16)} disabled={!form.observedAt}
                onChange={(e) => setForm((f) => ({ ...f, observedAt: `${f.observedAt.slice(0, 10)}T${e.target.value || '00:00'}` }))} />
            </div>
            <input type="number" min="1" placeholder="Duration (minutes)" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} />
            <select aria-label="Method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              <option value="IN_PERSON">In person</option>
              <option value="REMOTE">Remote</option>
              <option value="HYBRID">Hybrid</option>
            </select>
            <textarea placeholder="Summary" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
            <div className="ui-row">
              <Button type="button" onClick={() => createMut.mutate()} disabled={!canCreate || createMut.isPending}>
                {createMut.isPending ? 'Saving…' : 'Create observation'}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <h2>Observations</h2>
        {observations.isLoading ? <LoadingState label="Loading observations…" /> : null}
        {observations.isError ? <ErrorState message="Could not load observations." onRetry={() => observations.refetch()} /> : null}
        {observations.data && observations.data.length === 0 ? <EmptyState message="No observations yet." /> : null}
        {observations.data && observations.data.length > 0 ? (
          <table className="table">
            <thead><tr><th>Supervisee</th><th>Observed</th><th>Minutes</th><th>Status</th><th /></tr></thead>
            <tbody>
              {observations.data.map((o) => (
                <tr key={o.id}>
                  <td>{o.superviseeStaffId}</td>
                  <td>{formatDateTime(o.observedAt)}</td>
                  <td>{o.durationMinutes}</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>
                    <div className="ui-row">
                      {o.status === 'DRAFT' && canLog ? <Button variant="ghost" onClick={() => setConfirm({ obs: o, action: 'submit' })}>Submit</Button> : null}
                      {o.status === 'SUBMITTED' && canSign ? <Button variant="ghost" onClick={() => setConfirm({ obs: o, action: 'sign' })}>Sign off</Button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>

      {confirm ? (
        <ConfirmDialog
          title={confirm.action === 'sign' ? 'Sign off observation' : 'Submit observation'}
          message={confirm.action === 'sign'
            ? 'Signing is final. The observation becomes immutable and its hours are recorded. Continue?'
            : 'Submit this observation for sign-off?'}
          confirmLabel={confirm.action === 'sign' ? 'Sign off' : 'Submit'}
          busy={workflowMut.isPending}
          onConfirm={() => workflowMut.mutate(confirm)}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}
