import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listClients, listAuthorizations, createBcbaManualSession, createRbtManualSession } from '@/api/client';
import { useToast } from '@/components';
import { useAuthStore } from '@/auth/store';
import { PageHeader, Card, Button, Icon, Field, Select, Textarea, DateInput } from '@/ui';
import { formatDate, formatDuration, formatFullName } from '@/lib/format';

/**
 * MANUAL SESSION — BCBA and RBT.
 *
 * Records a completed session through the EXISTING pipeline: the server creates
 * a real Session + SessionTimeRecord (the same records Start/Stop produces), so
 * the entry flows into My Hours, Payroll and Insurance Billing with no
 * manual-only calculation. This page only collects input:
 *
 *   Client, Date (MM/DD/YYYY), From / To (15-minute steps), Authorization(s),
 *   Session Memo  →  "Add Manual Session"
 *
 * The server decides everything that matters — the clinician (from the token),
 * the worked minutes, the 15-minute rule, end-after-start, authorization
 * validity and conflicts — and its error messages are shown as returned.
 */

/** 15-minute clock options: value "HH:mm", label "h:mm AM". */
export const TIME_OPTIONS = (() => {
  const opts = [];
  for (let m = 0; m < 24 * 60; m += 15) {
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, '0');
    const h12 = h % 12 === 0 ? 12 : h % 12;
    opts.push({ value: `${String(h).padStart(2, '0')}:${mm}`, label: `${h12}:${mm} ${h < 12 ? 'AM' : 'PM'}` });
  }
  return opts;
})();
const minutesOf = (hhmm) => { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

const USABLE = new Set(['ACTIVE', 'APPROVED']);
/** Authorization dates are date-only calendar bounds — read their calendar parts, never shift them. */
const authDate = (v) => (v ? formatDate(String(v).slice(0, 10)) : '');
const authLabel = (a) => {
  const title = [a.serviceCode || a.serviceType, a.payerName, a.authorizationNumber].filter(Boolean).join(' · ') || 'Authorization';
  const start = authDate(a.startDate);
  const end = authDate(a.endDate);
  return { title, range: start || end ? `${start || '—'} – ${end || '—'}` : '' };
};
const coversDate = (a, iso) => {
  if (!iso) return true;
  const s = a.startDate ? String(a.startDate).slice(0, 10) : null;
  const e = a.endDate ? String(a.endDate).slice(0, 10) : null;
  return (!s || iso >= s) && (!e || iso <= e);
};

/** Which clinician endpoint this user records through; null when neither role. */
export function manualSessionRole(roles = []) {
  const keys = (Array.isArray(roles) ? roles : []).map(String);
  if (keys.includes('bcba')) return 'BCBA';
  if (keys.includes('rbt')) return 'RBT';
  return null;
}

export function ManualSessionPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const roles = useAuthStore((s) => s.principal?.roles ?? s.principal?.roleKeys ?? []);
  const role = manualSessionRole(roles);

  const [clientId, setClientId] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [authorizationIds, setAuthorizationIds] = useState([]);
  const [memo, setMemo] = useState('');
  const [err, setErr] = useState('');

  const clients = useQuery({ queryKey: ['clients', 'manual-session'], queryFn: () => listClients({ limit: 100 }), enabled: Boolean(role) });
  const authorizations = useQuery({
    queryKey: ['authorizations', 'manual-session', clientId],
    queryFn: () => listAuthorizations({ clientId }),
    enabled: Boolean(role && clientId),
  });

  const clientOpts = useMemo(() => (clients.data?.items ?? []).map((c) => ({ value: c.id, label: formatFullName(c) || 'Client' })), [clients.data]);
  // Only usable authorizations (saved, not denied — the server maps them to ACTIVE) valid on the chosen date are offered.
  const authOptions = useMemo(
    () => (authorizations.data?.items ?? []).filter((a) => USABLE.has(a.status) && coversDate(a, date)),
    [authorizations.data, date],
  );

  const startM = minutesOf(startTime);
  const endM = minutesOf(endTime);
  const durationMin = startM != null && endM != null && endM > startM ? endM - startM : null;

  const mutation = useMutation({
    mutationFn: () => (role === 'RBT' ? createRbtManualSession : createBcbaManualSession)({
      clientId, date, startTime, endTime, authorizationIds,
      ...(memo.trim() ? { memo: memo.trim() } : {}),
    }),
    onSuccess: (res) => {
      toast.push(res?.alreadyExists ? 'This manual session was already added.' : 'Manual session added successfully.');
      // The new session is visible immediately wherever sessions and hours are read.
      for (const key of [['sessions'], ['session'], ['insights'], ['bcba'], ['rbt'], ['dashboard'], ['payroll'], ['appointments']]) {
        qc.invalidateQueries({ queryKey: key });
      }
      setStartTime(''); setEndTime(''); setMemo(''); setAuthorizationIds([]);
    },
    onError: (e) => {
      const m = e?.response?.data?.error?.message;
      setErr(m && !/^[A-Z_]+-?\d*$/.test(m) ? m : 'The manual session could not be added. Check the details and try again.');
    },
  });

  if (!role) return <Navigate to="/" replace />;

  const toggleAuth = (id) => setAuthorizationIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  function submit() {
    setErr('');
    if (!clientId || !date || !startTime || !endTime) { setErr('Select a client, date, start time and end time.'); return; }
    if (startM % 15 !== 0 || endM % 15 !== 0) { setErr('Session times must be in 15-minute increments.'); return; }
    if (endM <= startM) { setErr('End time must be after start time.'); return; }
    if (authorizationIds.length === 0) { setErr('Select an authorization for this client.'); return; }
    mutation.mutate();
  }

  return (
    <>
      <PageHeader eyebrow="Session delivery" title="Manual Session" subtitle="Record a completed session with its date, time and authorization." />
      <Card className="rx-manual">
        <div className="rx-manual__grid">
          <Field label="Client" required>
            <Select
              value={clientId}
              onChange={(v) => { setClientId(v); setAuthorizationIds([]); }}
              options={clientOpts}
              loading={clients.isLoading}
              placeholder="Select a client"
            />
          </Field>
          <Field label="Date" required>
            <DateInput value={date} onChange={(e) => { setDate(e?.target?.value ?? e); setAuthorizationIds([]); }} aria-label="Session date" />
          </Field>
          <Field label="From" required>
            <Select value={startTime} onChange={setStartTime} options={TIME_OPTIONS} placeholder="Select start time" />
          </Field>
          <Field label="To" required hint={durationMin != null ? `${formatDuration(durationMin)} worked` : undefined}>
            <Select value={endTime} onChange={setEndTime} options={TIME_OPTIONS} placeholder="Select end time" />
          </Field>
        </div>

        <Field label="Authorization(s)" required>
          {!clientId ? (
            <div className="rx-manual__hint">Select a client to see their authorizations.</div>
          ) : authorizations.isLoading ? (
            <div className="rx-manual__hint">Loading authorizations…</div>
          ) : authOptions.length === 0 ? (
            <div className="rx-manual__hint">No authorizations are available for this client{date ? ' on this date' : ''}.</div>
          ) : (
            <div className="rx-manual__auths" role="group" aria-label="Authorizations">
              {authOptions.map((a) => {
                const { title, range } = authLabel(a);
                const checked = authorizationIds.includes(a.id);
                return (
                  <label key={a.id} className={`rx-manual__auth${checked ? ' is-checked' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleAuth(a.id)} />
                    <span className="rx-manual__auth-title">{title}</span>
                    {range && <span className="rx-manual__auth-range">{range}</span>}
                  </label>
                );
              })}
            </div>
          )}
        </Field>

        <Field label="Session Memo">
          <Textarea value={memo} onChange={(e) => setMemo(e.target?.value ?? e)} rows={4} placeholder="Add a session memo..." />
        </Field>

        {err && <p className="rx-formfield__err" role="alert" style={{ marginTop: 4 }}>{err}</p>}

        <div className="rx-manual__actions">
          <Button icon={Icon.Plus} onClick={submit} loading={mutation.isPending} disabled={mutation.isPending}>Add Manual Session</Button>
        </div>
      </Card>
    </>
  );
}

export default ManualSessionPage;
