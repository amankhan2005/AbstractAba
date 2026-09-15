import { formatDateTime } from '@/lib/format';
import { usePermissions } from '@/auth/permissions';
import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDataPoint, freezeSession, getSession, getPlan, removeDataPoint, updateSession } from '@/api/client';
import { Button, Card, LoadingState, ErrorState } from '@/components';
import { SessionLifecyclePanel } from './SessionLifecyclePanel';

const SCALAR = ['FREQUENCY', 'DURATION', 'RATE', 'TRIALS_TO_CRITERION'];
const RATIO = ['PERCENT_CORRECT', 'INTERVAL'];

/**
 * The session capture surface. Field usability first: large touch targets for
 * per-target data entry (this view keeps big tap targets regardless of density).
 * Data points are captured against the plan's active targets; the narrative is
 * PHI (opened only here). Freezing locks the record — after that it is read-only.
 */
export function SessionDetailPage() {
  const { sessionId } = useParams();
  const queryClient = useQueryClient();
  const { permissions: permissions, ready: authReady } = usePermissions();
  const canWrite = permissions.includes('sessions.write');
  const canFreeze = permissions.includes('sessions.freeze');

  const detail = useQuery({ queryKey: ['session', sessionId], queryFn: () => getSession(sessionId) });
  const planId = detail.data?.session?.treatmentPlanId;
  const plan = useQuery({ queryKey: ['plan', planId], queryFn: () => getPlan(planId), enabled: Boolean(planId) });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['session', sessionId] });

  const freezeMut = useMutation({ mutationFn: () => freezeSession(sessionId), onSuccess: invalidate });
  const removeMut = useMutation({ mutationFn: (dpId) => removeDataPoint(sessionId, dpId), onSuccess: invalidate });

  // flatten the plan tree into a target picker (only active targets are bookable)
  const targets = useMemo(() => {
    const out = [];
    for (const goal of plan.data?.goals ?? []) {
      for (const program of goal.programs ?? []) {
        for (const target of program.targets ?? []) {
          if (target.status === 'ACTIVE' && !target.archivedAt) out.push({ ...target, programName: program.name });
        }
      }
    }
    return out;
  }, [plan.data]);

  if (detail.isLoading) return <LoadingState label="Loading session…" />;
  if (detail.isError) return <ErrorState message="Could not load the session." onRetry={() => detail.refetch()} />;

  const { session, dataPoints } = detail.data;
  const frozen = session.status === 'FROZEN';

  return (
    <div className="ui-stack">
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <h1>Session</h1>
        <Link className="linklike" to="/sessions">← All sessions</Link>
      </div>

      {/*
        The lifecycle panel replaces what used to be a raw status string and a
        lone "Freeze session" button. That older card exposed the enum name to
        the user and offered exactly one of the seven documented transitions —
        no clock in or out, no signatures, no way to send a session back, and
        no way to cancel one that never happened.
      */}
      <SessionLifecyclePanel
        session={session}
        canWrite={canWrite}
        canReview={canFreeze}
        onChanged={invalidate}
      />

      <Card>
        <p className="muted">
          Started {session.startedAt ? formatDateTime(session.startedAt) : '—'}
        </p>
        {session.narrative ? <p>{session.narrative}</p> : <p className="muted">No session note.</p>}
      </Card>

      {canWrite && !frozen ? <CapturePanel sessionId={sessionId} targets={targets} onCaptured={invalidate} /> : null}

      <Card>
        <h2>Data points</h2>
        {dataPoints.length === 0 ? <p className="muted">No data captured yet.</p> : (
          <table className="table">
            <thead><tr><th>Target</th><th>Measure</th><th>Value</th>{!frozen && canWrite ? <th /> : null}</tr></thead>
            <tbody>
              {dataPoints.map((dp) => (
                <tr key={dp.id}>
                  <td>{dp.targetId}</td>
                  <td>{dp.measurementType}</td>
                  <td>{dp.denominator != null ? `${dp.numerator}/${dp.denominator}` : dp.value}</td>
                  {!frozen && canWrite ? (
                    <td><button type="button" className="linklike" onClick={() => removeMut.mutate(dp.id)}>remove</button></td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/** Large-target data-entry panel: pick a target, enter the measurement, capture. */
function CapturePanel({ sessionId, targets, onCaptured }) {
  const [targetId, setTargetId] = useState('');
  const [value, setValue] = useState('');
  const [numerator, setNumerator] = useState('');
  const [denominator, setDenominator] = useState('');
  const [error, setError] = useState(null);

  const chosen = targets.find((t) => t.id === targetId);
  const measurementType = chosen?.measurementType;
  const isRatio = measurementType && RATIO.includes(measurementType);
  const isScalar = measurementType && SCALAR.includes(measurementType);

  const mut = useMutation({
    mutationFn: (body) => addDataPoint(sessionId, body),
    onSuccess: () => { setValue(''); setNumerator(''); setDenominator(''); setError(null); onCaptured(); },
    onError: (err) => setError(err.response?.data?.error?.message ?? 'Could not capture the data point.'),
  });

  const capture = () => {
    if (!chosen) { setError('Choose a target first.'); return; }
    const body = { targetId: chosen.id, measurementType };
    if (isRatio) { body.numerator = Number(numerator); body.denominator = Number(denominator); }
    else { body.value = Number(value); }
    mut.mutate(body);
  };

  return (
    <Card>
      <h2>Capture data</h2>
      <div className="capture-grid">
        <label className="capture-field">
          <span>Target</span>
          <select className="input capture-input" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Select a target…</option>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.programName} · {t.label} ({t.measurementType})</option>)}
          </select>
        </label>

        {isScalar ? (
          <label className="capture-field">
            <span>Value</span>
            <input className="input capture-input" type="number" inputMode="decimal" min="0" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        ) : null}

        {isRatio ? (
          <div className="capture-ratio">
            <label className="capture-field">
              <span>Correct</span>
              <input className="input capture-input" type="number" inputMode="numeric" min="0" value={numerator} onChange={(e) => setNumerator(e.target.value)} />
            </label>
            <label className="capture-field">
              <span>Total</span>
              <input className="input capture-input" type="number" inputMode="numeric" min="1" value={denominator} onChange={(e) => setDenominator(e.target.value)} />
            </label>
          </div>
        ) : null}
      </div>

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="ui-row">
        <button type="button" className="capture-btn" onClick={capture} disabled={mut.isPending || !chosen}>
          {mut.isPending ? 'Capturing…' : 'Capture'}
        </button>
      </div>
    </Card>
  );
}
