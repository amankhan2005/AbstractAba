import { formatDate, formatDateTime } from '@/lib/format';
import { usePermissions } from '@/auth/permissions';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listSeries, createSeries, getSeries, cancelSeries, cancelSeriesOccurrence, listClients } from '@/api/client';
import { Button, Card, StatusBadge, LoadingState, ErrorState, EmptyState, ConfirmDialog, useToast } from '@/components';
import { DateInput } from '@/ui';

const WEEKDAYS = [['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]];
const EMPTY = {
  clientId: '', staffProfileId: '', authorizationId: '',
  frequency: 'WEEKLY', interval: 1, byWeekday: [], startDate: '',
  startTime: '09:00', endTime: '10:00', count: '', untilDate: '',
};

const toMinute = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fmt = (d) => (d ? formatDateTime(d) : '');

/**
 * Recurring appointment series. Creating a series materializes concrete
 * appointments server-side (reusing the full booking validation); occurrences
 * that fail validation come back as "skipped" so the user sees exactly what was
 * booked. Creating/cancelling occurrences requires scheduling.write; cancelling
 * a whole series requires scheduling.manage. The server is authoritative.
 */
export function RecurringSeriesPage() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canWrite = permissions.includes('scheduling.write');
  const canManage = permissions.includes('scheduling.manage');
  const queryClient = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState(null);
  const [openSeriesId, setOpenSeriesId] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [lastResult, setLastResult] = useState(null);

  const clients = useQuery({ queryKey: ['clients', { limit: 100 }], queryFn: () => listClients({ limit: 100 }) });
  const query = useQuery({ queryKey: ['series', 'all'], queryFn: () => listSeries({ limit: 50 }) });
  const detail = useQuery({ queryKey: ['series', openSeriesId], queryFn: () => getSeries(openSeriesId), enabled: !!openSeriesId });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggleWeekday = (n) => setForm((f) => ({ ...f, byWeekday: f.byWeekday.includes(n) ? f.byWeekday.filter((x) => x !== n) : [...f.byWeekday, n] }));

  /**
   * Validates the recurrence configuration before anything is submitted.
   * Returns a plain-language message, or null when the configuration is usable.
   * These are the three shapes the server would otherwise reject with a 422 the
   * user cannot act on.
   */
  const recurrenceProblem = (f) => {
    if (!f.frequency) return 'Please select a recurrence type.';
    if (f.frequency === 'WEEKLY' && f.byWeekday.length === 0) {
      return 'Please choose at least one day of the week for this weekly series.';
    }
    if (!f.count && !f.untilDate) {
      return 'Please set either how many sessions to book, or an end date.';
    }
    if (f.count && f.untilDate) {
      return 'Please set either a number of sessions or an end date, not both.';
    }
    if (toMinute(f.endTime) <= toMinute(f.startTime)) {
      return 'The end time needs to be later than the start time.';
    }
    if (f.untilDate && f.startDate && f.untilDate < f.startDate) {
      return 'The end date needs to be on or after the start date.';
    }
    return null;
  };

  const submitSeries = () => {
    const problem = recurrenceProblem(form);
    if (problem) { setError(problem); return; }
    setError(null);
    createMut.mutate();
  };

  const createMut = useMutation({
    mutationFn: () => {
      const body = {
        clientId: form.clientId, staffProfileId: form.staffProfileId, authorizationId: form.authorizationId,
        frequency: form.frequency, interval: Number(form.interval) || 1,
        startDate: new Date(form.startDate).toISOString(),
        startMinute: toMinute(form.startTime), endMinute: toMinute(form.endTime),
      };
      if (form.frequency === 'WEEKLY' && form.byWeekday.length) body.byWeekday = form.byWeekday;
      if (form.count) body.count = Number(form.count);
      else if (form.untilDate) body.untilDate = new Date(form.untilDate).toISOString();
      return createSeries(body);
    },
    onSuccess: async (result) => {
      setForm(EMPTY); setShowForm(false); setError(null); setLastResult(result);
      toast.push(`Series created: ${result.booked.length} booked, ${result.skipped.length} skipped.`);
      await queryClient.invalidateQueries({ queryKey: ['series'] });
      await queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
    onError: (err) => setError(err?.response?.data?.error?.message ?? 'Could not create the series.'),
  });

  const cancelSeriesMut = useMutation({
    mutationFn: (seriesId) => cancelSeries(seriesId),
    onSuccess: async (res) => {
      setConfirm(null);
      toast.push(`Series cancelled (${res.cancelledOccurrences} future occurrences).`);
      await queryClient.invalidateQueries({ queryKey: ['series'] });
    },
    onError: (err) => { setConfirm(null); toast.push(err?.response?.data?.error?.message ?? 'Could not cancel the series.', 'negative'); },
  });

  const cancelOccMut = useMutation({
    mutationFn: ({ seriesId, appointmentId }) => cancelSeriesOccurrence(seriesId, appointmentId),
    onSuccess: async () => {
      setConfirm(null);
      toast.push('Occurrence cancelled.');
      await queryClient.invalidateQueries({ queryKey: ['series', openSeriesId] });
    },
    onError: (err) => { setConfirm(null); toast.push(err?.response?.data?.error?.message ?? 'Could not cancel the occurrence.', 'negative'); },
  });

  if (query.isLoading) return <LoadingState label="Loading recurring series…" />;
  if (query.isError) return <ErrorState message="Could not load recurring series." onRetry={() => query.refetch()} />;

  const rows = query.data ?? [];

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>Recurring appointments</h1>
        {canWrite ? <Button variant="ghost" onClick={() => setShowForm((v) => !v)}>{showForm ? 'Close' : 'New series'}</Button> : null}
      </div>

      {showForm ? (
        <Card>
          <form onSubmit={(e) => { e.preventDefault(); submitSeries(); }}>
            <div className="ui-fields">
              <label>Client
                <select value={form.clientId} onChange={set('clientId')} required>
                  <option value="">Select…</option>
                  {(clients.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.displayName ?? c.id}</option>)}
                </select>
              </label>
              <label>Staff profile ID<input value={form.staffProfileId} onChange={set('staffProfileId')} required /></label>
              <label>Authorization ID<input value={form.authorizationId} onChange={set('authorizationId')} required /></label>
              <label>Frequency
                <select value={form.frequency} onChange={set('frequency')}>
                  <option value="WEEKLY">Weekly</option>
                  <option value="DAILY">Daily</option>
                </select>
              </label>
              <label>Every N (interval)<input type="number" min="1" max="52" value={form.interval} onChange={set('interval')} /></label>
              <label>Start date<DateInput value={form.startDate} onChange={set('startDate')} required aria-label="Series start date" /></label>
              <label>Start time<input type="time" value={form.startTime} onChange={set('startTime')} required /></label>
              <label>End time<input type="time" value={form.endTime} onChange={set('endTime')} required /></label>
              <label>Occurrence count (or set end date)<input type="number" min="1" max="366" value={form.count} onChange={set('count')} /></label>
              <label>Until date<DateInput value={form.untilDate} onChange={set('untilDate')} aria-label="Series until date" /></label>
            </div>

            {form.frequency === 'WEEKLY' ? (
              <div className="ui-row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                {WEEKDAYS.map(([label, n]) => (
                  <label key={n} className="ui-row" style={{ gap: '0.25rem', alignItems: 'center' }}>
                    <input type="checkbox" checked={form.byWeekday.includes(n)} onChange={() => toggleWeekday(n)} />{label}
                  </label>
                ))}
              </div>
            ) : null}

            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <div className="ui-row" style={{ marginTop: '0.75rem' }}>
              <Button type="submit" disabled={createMut.isPending}>{createMut.isPending ? 'Creating…' : 'Create series'}</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {lastResult ? (
        <Card>
          <p className="muted">Last series: <strong>{lastResult.booked.length}</strong> booked, <strong>{lastResult.skipped.length}</strong> skipped.</p>
          {lastResult.skipped.length ? (
            <ul>
              {lastResult.skipped.map((s, i) => <li key={i} className="muted">{fmt(s.startAt)} — {s.reason}</li>)}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState message="No recurring series yet." />
      ) : (
        <Card>
          <table className="ui-table">
            <thead><tr><th>Frequency</th><th>Start</th><th>Bounds</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>{s.frequency}{s.interval > 1 ? ` ×${s.interval}` : ''}{s.byWeekday?.length ? ` (${s.byWeekday.map((n) => WEEKDAYS[n][0]).join(',')})` : ''}</td>
                  <td>{fmt(s.startDate)}</td>
                  <td>{s.count ? `${s.count} occ.` : (s.untilDate ? `until ${formatDate(s.untilDate)}` : '—')}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="ui-row" style={{ gap: '0.5rem' }}>
                    <Button variant="ghost" onClick={() => setOpenSeriesId(openSeriesId === s.id ? null : s.id)}>{openSeriesId === s.id ? 'Hide' : 'View'}</Button>
                    {canManage && s.status === 'ACTIVE' ? (
                      <Button variant="ghost" onClick={() => setConfirm({ kind: 'series', seriesId: s.id })}>Cancel series</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {openSeriesId && detail.data ? (
        <Card>
          <h2>Occurrences</h2>
          {detail.data.appointments.length === 0 ? <EmptyState message="No materialized occurrences." /> : (
            <table className="ui-table">
              <thead><tr><th>Start</th><th>End</th><th>Status</th><th /></tr></thead>
              <tbody>
                {detail.data.appointments.map((a) => (
                  <tr key={a.id}>
                    <td>{fmt(a.startAt)}</td><td>{fmt(a.endAt)}</td><td><StatusBadge status={a.status} /></td>
                    <td>{canWrite && a.status === 'SCHEDULED' ? (
                      <Button variant="ghost" onClick={() => setConfirm({ kind: 'occurrence', seriesId: openSeriesId, appointmentId: a.id })}>Cancel</Button>
                    ) : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title={confirm.kind === 'series' ? 'Cancel entire series?' : 'Cancel this occurrence?'}
          message={confirm.kind === 'series'
            ? 'This cancels all future scheduled occurrences and restores their authorization units. Past occurrences are kept as history.'
            : 'This cancels the single occurrence and restores its authorization units.'}
          confirmLabel="Cancel it"
          tone="danger"
          busy={cancelSeriesMut.isPending || cancelOccMut.isPending}
          onConfirm={() => {
            // Belt-and-braces. The dialog now honours `open`, so this cannot be
            // reached with a null target — but a confirm handler that assumed
            // its state existed is how the original crash happened, so it no
            // longer assumes.
            if (!confirm) return;
            if (confirm.kind === 'series') cancelSeriesMut.mutate(confirm.seriesId);
            else cancelOccMut.mutate({ seriesId: confirm.seriesId, appointmentId: confirm.appointmentId });
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}
