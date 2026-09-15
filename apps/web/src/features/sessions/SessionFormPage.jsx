import { formatDateTime } from '@/lib/format';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createSession, listAppointments, listPlans } from '@/api/client';
import { Button, Card, LoadingState, ErrorState } from '@/components';

const EMPTY = { appointmentId: '', treatmentPlanId: '', narrative: '' };

/**
 * Start a session for a booked appointment. The appointment supplies the client
 * and staff; the treatment plan must be the client's ACTIVE plan (the server
 * enforces both). The narrative is PHI and is sealed on the server.
 */
export function SessionFormPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const appointments = useQuery({ queryKey: ['appointments', { limit: 100 }], queryFn: () => listAppointments({ limit: 100 }) });
  const plans = useQuery({ queryKey: ['plans', { status: 'ACTIVE', limit: 100 }], queryFn: () => listPlans({ status: 'ACTIVE', limit: 100 }) });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body = { appointmentId: form.appointmentId, treatmentPlanId: form.treatmentPlanId };
      if (form.narrative.trim()) body.narrative = form.narrative.trim();
      const created = await createSession(body);
      navigate(`/sessions/${created.id}`);
    } catch (err) {
      setError(err.response?.data?.error?.message ?? 'Could not start the session.');
    } finally {
      setSaving(false);
    }
  };

  if (appointments.isLoading || plans.isLoading) return <LoadingState label="Loading…" />;
  if (appointments.isError || plans.isError) return <ErrorState message="Could not load appointments or plans." />;

  const appointmentItems = appointments.data?.items ?? [];
  const planItems = plans.data?.items ?? [];

  return (
    <div className="ui-stack">
      <h1>Start session</h1>
      <Card>
        <form className="ui-fields" onSubmit={submit}>
          <label className="ui-field">
            <span>Appointment</span>
            <select className="input" value={form.appointmentId} onChange={set('appointmentId')} required>
              <option value="">Select an appointment…</option>
              {appointmentItems.map((a) => (
                <option key={a.id} value={a.id}>
                  {formatDateTime(a.startAt)} · {a.clientId}
                </option>
              ))}
            </select>
          </label>

          <label className="ui-field">
            <span>Active treatment plan</span>
            <select className="input" value={form.treatmentPlanId} onChange={set('treatmentPlanId')} required>
              <option value="">Select the client's active plan…</option>
              {planItems.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </label>

          <label className="ui-field">
            <span>Session note (optional)</span>
            <textarea className="input" rows={4} value={form.narrative} onChange={set('narrative')} />
          </label>

          {error ? <p className="form-error" role="alert">{error}</p> : null}

          <div className="ui-row">
            <Button type="submit" disabled={saving}>{saving ? 'Starting…' : 'Start session'}</Button>
            <Button type="button" variant="ghost" onClick={() => navigate('/sessions')}>Cancel</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
