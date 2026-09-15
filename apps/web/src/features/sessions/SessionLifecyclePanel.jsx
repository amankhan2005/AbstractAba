import { useState } from 'react';
import { formatTime } from '@/lib/format';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  clockInSession, clockOutSession, captureSessionSignature, submitSession,
  freezeSession, returnSession, cancelSession, amendSession,
} from '@/api/client';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';

/**
 * ---------------------------------------------------------------------------
 * SESSION LIFECYCLE CONTROLS — blueprint Figure 6.2.
 *
 *   Scheduled ─▶ In progress ─▶ Captured ─▶ Submitted ─▶ Approved ─▶ Amended
 *                     │                          │
 *                     └──▶ Cancelled             └──▶ Returned ──┐
 *                                     ▲                          │
 *                                     └──────────────────────────┘
 *
 * THIS COMPONENT OWNS NO STATE MACHINE. The backend does. Every action here
 * calls the transition endpoint that already exists and then re-reads the
 * server's answer; nothing sets `status` directly, and the button set is
 * DERIVED from the status the server returned rather than from a local guess
 * about what happens next.
 *
 * That distinction matters beyond tidiness. If the UI modelled the lifecycle
 * too, the two models would drift, and the visible one would start authorising
 * things the real one refuses — which is how a technician ends up staring at an
 * enabled Submit button that always fails.
 *
 * The UI hiding an action is a courtesy, never a control: `assertTransition`,
 * `assertMayApprove` and the scope guards refuse the same things server-side
 * whatever this renders.
 * ---------------------------------------------------------------------------
 */

/** Plain-language state names. A user never sees DRAFT or FROZEN. */
const STATE_VIEW = {
  DRAFT: { label: 'Ready to start', tone: 'info', help: 'Clock in when you arrive to begin this session.' },
  IN_PROGRESS: { label: 'In progress', tone: 'success', help: 'Collect data as you go, then clock out when the session ends.' },
  SUBMITTED: { label: 'Waiting for review', tone: 'info', help: 'Your supervisor will review this and either approve it or send it back.' },
  RETURNED: { label: 'Sent back for changes', tone: 'warning', help: 'Your supervisor has asked for a correction. Make the changes, then submit again.' },
  FROZEN: { label: 'Approved', tone: 'success', help: 'This session is approved and can no longer be changed. Corrections are recorded as amendments.' },
  AMENDED: { label: 'Amended', tone: 'muted', help: 'This session has been replaced by a corrected record.' },
  CANCELLED: { label: 'Cancelled', tone: 'muted', help: 'This session did not take place.' },
};

const CANCELLATION_REASONS = [
  ['CLIENT_CANCEL', 'The family cancelled'],
  ['PROVIDER_CANCEL', 'We cancelled'],
  ['NO_SHOW', 'Nobody was there'],
  ['ILLNESS', 'Illness'],
  ['WEATHER', 'Weather'],
  ['HOLIDAY', 'Holiday'],
  ['AGENCY', 'Agency reason'],
];

export function SessionLifecyclePanel({ session, canWrite, canReview, onChanged }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState(null); // 'cancel' | 'submit' | 'approve' | 'return' | 'amend'
  // Completeness problems returned by a refused submission, listed inline.
  const [blockers, setBlockers] = useState(null);
  const [reasonCode, setReasonCode] = useState('CLIENT_CANCEL');
  const [comment, setComment] = useState('');

  const status = session?.status ?? 'DRAFT';
  const view = STATE_VIEW[status] ?? STATE_VIEW.DRAFT;

  const done = (message) => {
    setDialog(null);
    setComment('');
    qc.invalidateQueries({ queryKey: ['session', session.id] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    onChanged?.();
    toast.push(message);
  };

  /**
   * A single failure path for every transition. The API already sends
   * plain-language refusals ("A session that is approved cannot become in
   * progress"); this only guards against a network error surfacing as
   * "Request failed with status code 500".
   */
  const fail = (err) => {
    const error = err?.response?.data?.error;
    // A refused submission returns EVERY completeness problem (§6.6: "failures
    // are shown inline with what to fix"). Showing only the first would make a
    // technician submit, fix, resubmit and discover the next — at the end of a
    // home visit with a family waiting.
    const problems = error?.details?.problems;
    if (Array.isArray(problems) && problems.length > 0) {
      setBlockers(problems);
      return;
    }
    setBlockers(null);
    const message = error?.message;
    toast.push(message && !/^[A-Z]+-\d+$/.test(message)
      ? message
      : 'We couldn’t do that just now. Please try again.');
  };

  // Each transition is its own mutation, declared unconditionally and in a
  // fixed order. Sharing one generic mutation would lose the per-action
  // pending state the buttons need.
  const clockIn = useMutation({
    mutationFn: async () => clockInSession(session.id, await capturePlace()),
    onSuccess: () => done('Clocked in.'), onError: fail,
  });
  const clockOut = useMutation({
    mutationFn: async () => clockOutSession(session.id, await capturePlace()),
    onSuccess: () => done('Clocked out.'), onError: fail,
  });
  const submit = useMutation({
    mutationFn: () => submitSession(session.id),
    onSuccess: () => done('Session submitted for review.'), onError: fail,
  });
  const approve = useMutation({
    mutationFn: () => freezeSession(session.id),
    onSuccess: () => done('Session approved.'), onError: fail,
  });
  const sendBack = useMutation({
    mutationFn: () => returnSession(session.id, comment),
    onSuccess: () => done('Sent back to the technician.'), onError: fail,
  });
  const cancel = useMutation({
    mutationFn: () => cancelSession(session.id, { reasonCode, ...(comment ? { note: comment } : {}) }),
    onSuccess: () => done('Session cancelled.'), onError: fail,
  });
  const amend = useMutation({
    mutationFn: () => amendSession(session.id, { reason: comment }),
    onSuccess: () => done('Amendment recorded.'), onError: fail,
  });
  const sign = useMutation({
    mutationFn: (role) => captureSessionSignature(session.id, { role }),
    onSuccess: () => done('Signature captured.'), onError: fail,
  });

  const busy = [clockIn, clockOut, submit, approve, sendBack, cancel, amend, sign]
    .some((m) => m.isPending);

  // Which actions exist AT ALL in this state — mirroring SESSION_TRANSITIONS.
  const canClockIn = canWrite && status === 'DRAFT' && !session.clockInAt;
  const canClockOut = canWrite && status === 'IN_PROGRESS' && !session.clockOutAt;
  const canSubmit = canWrite && ['IN_PROGRESS', 'RETURNED'].includes(status) && Boolean(session.clockOutAt);
  const canCancel = canWrite && ['DRAFT', 'IN_PROGRESS', 'RETURNED'].includes(status);
  const canSign = canWrite && ['IN_PROGRESS', 'RETURNED'].includes(status);
  const canApprove = canReview && status === 'SUBMITTED';
  const canSendBack = canReview && status === 'SUBMITTED';
  const canAmend = canReview && status === 'FROZEN';

  const signatures = session.signatures ?? [];
  const hasSignature = (role) => signatures.some((s) => s.role === role);

  return (
    <Card>
      <div className="lifecycle__head">
        <div>
          <span className={`ui-badge ui-badge--${view.tone}`}>{view.label}</span>
          <p className="lifecycle__help">{view.help}</p>
        </div>
        <dl className="lifecycle__times">
          <div><dt>Clocked in</dt><dd>{time(session.clockInAt)}</dd></div>
          <div><dt>Clocked out</dt><dd>{time(session.clockOutAt)}</dd></div>
          <div><dt>Duration</dt><dd>{duration(session.clockInAt, session.clockOutAt)}</dd></div>
        </dl>
      </div>

      {status === 'RETURNED' && session.returnComment ? (
        <div className="lifecycle__returned" role="alert">
          <strong>What needs fixing</strong>
          <p>{session.returnComment}</p>
        </div>
      ) : null}

      {canSign ? (
        <div className="lifecycle__signatures">
          <span className="lifecycle__sig-label">Signatures</span>
          {['GUARDIAN', 'TECHNICIAN'].map((role) => (
            <Button
              key={role}
              variant="ghost"
              disabled={busy || hasSignature(role)}
              onClick={() => sign.mutate(role)}
            >
              {hasSignature(role)
                ? `${role === 'GUARDIAN' ? 'Parent' : 'Your'} signature captured`
                : `Capture ${role === 'GUARDIAN' ? 'parent' : 'your'} signature`}
            </Button>
          ))}
        </div>
      ) : null}

      {blockers ? (
        <div className="lifecycle__blockers" role="alert">
          <p className="lifecycle__blockers-title">This session isn’t ready to submit yet:</p>
          <ul>
            {blockers.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        </div>
      ) : null}

      <div className="lifecycle__actions">
        {canClockIn ? <Button onClick={() => clockIn.mutate()} disabled={busy}>{clockIn.isPending ? 'Clocking in…' : 'Clock in'}</Button> : null}
        {canClockOut ? <Button onClick={() => clockOut.mutate()} disabled={busy}>{clockOut.isPending ? 'Clocking out…' : 'Clock out'}</Button> : null}
        {canSubmit ? <Button onClick={() => setDialog('submit')} disabled={busy}>Submit for review</Button> : null}
        {canApprove ? <Button onClick={() => setDialog('approve')} disabled={busy}>Approve</Button> : null}
        {canSendBack ? <Button variant="ghost" onClick={() => setDialog('return')} disabled={busy}>Send back</Button> : null}
        {canAmend ? <Button variant="ghost" onClick={() => setDialog('amend')} disabled={busy}>Record an amendment</Button> : null}
        {canCancel ? <Button variant="ghost" onClick={() => setDialog('cancel')} disabled={busy}>Cancel session</Button> : null}
      </div>

      {canWrite && ['IN_PROGRESS', 'RETURNED'].includes(status) && !session.clockOutAt ? (
        <p className="lifecycle__hint">Clock out before submitting this session.</p>
      ) : null}

      {/* --- confirmations. No browser confirm() anywhere. --- */}

      <ConfirmDialog
        open={dialog === 'submit'}
        title="Submit this session?"
        message="Your supervisor will review it. You won’t be able to edit it while it’s waiting."
        confirmLabel="Submit"
        busy={submit.isPending}
        onConfirm={() => submit.mutate()}
        onCancel={() => setDialog(null)}
      />

      <ConfirmDialog
        open={dialog === 'approve'}
        title="Approve this session?"
        message="Approving locks the record permanently. Billing and payroll are calculated from it, and later corrections have to be recorded as amendments."
        confirmLabel="Approve"
        busy={approve.isPending}
        onConfirm={() => approve.mutate()}
        onCancel={() => setDialog(null)}
      />

      {dialog === 'return' ? (
        <ReasonDialog
          title="Send this session back"
          help="Tell the technician what needs fixing. They’ll see this straight away."
          placeholder="For example: the afternoon data is missing a prompt level."
          confirmLabel="Send back"
          value={comment}
          onChange={setComment}
          busy={sendBack.isPending}
          onConfirm={() => sendBack.mutate()}
          onCancel={() => { setDialog(null); setComment(''); }}
        />
      ) : null}

      {dialog === 'amend' ? (
        <ReasonDialog
          title="Record an amendment"
          help="The approved session stays exactly as it is. This creates a new, attributed correction alongside it."
          placeholder="Why is this correction needed?"
          confirmLabel="Record amendment"
          value={comment}
          onChange={setComment}
          busy={amend.isPending}
          onConfirm={() => amend.mutate()}
          onCancel={() => { setDialog(null); setComment(''); }}
        />
      ) : null}

      {dialog === 'cancel' ? (
        <div className="ui-modal-overlay" role="presentation">
          <div className="ui-modal" role="dialog" aria-modal="true" aria-label="Cancel session">
            <h2 className="ui-modal__title">Cancel this session</h2>
            <p className="ui-modal__body">Choose the reason. This affects billing and pay, so it matters which one.</p>
            <label className="lifecycle__field">
              <span>Reason</span>
              <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
                {CANCELLATION_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="lifecycle__field">
              <span>Anything to add? (optional)</span>
              <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <div className="ui-modal__footer">
              <Button variant="ghost" onClick={() => { setDialog(null); setComment(''); }} disabled={cancel.isPending}>Keep session</Button>
              <Button onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                {cancel.isPending ? 'Cancelling…' : 'Cancel session'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/** A modal whose confirm is blocked until a reason is actually written. */
function ReasonDialog({ title, help, placeholder, confirmLabel, value, onChange, busy, onConfirm, onCancel }) {
  return (
    <div className="ui-modal-overlay" role="presentation">
      <div className="ui-modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="ui-modal__title">{title}</h2>
        <p className="ui-modal__body">{help}</p>
        <label className="lifecycle__field">
          <textarea rows={4} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        </label>
        <div className="ui-modal__footer">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={onConfirm} disabled={busy || value.trim() === ''}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Coarse location for the verification record, captured AT the clock event —
 * §6.6's "Event-based location, never continuous tracking".
 *
 * Deliberately best-effort: §9.4's worked example is a technician in a family
 * home with no signal. A refusal or a failure yields no location, the session
 * proceeds, and the verification record is simply marked incomplete (BR-BL-5
 * holds the claim, not the care).
 */
async function capturePlace() {
  if (!navigator?.geolocation) return {};
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: 5000,
        maximumAge: 60_000,
        // Coarse is the requirement AND the privacy posture: a verified visit
        // needs to know the technician was at the home, not where in it.
        enableHighAccuracy: false,
      });
    });
    return {
      location: {
        latitude: round(position.coords.latitude),
        longitude: round(position.coords.longitude),
        accuracyMetres: Math.round(position.coords.accuracy ?? 0),
      },
    };
  } catch {
    // Denied, unavailable, or timed out. The session proceeds regardless.
    return {};
  }
}

/** ~100m precision. Enough to verify a visit, not enough to track a person. */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

function time(value) {
  if (!value) return '—';
  return formatTime(value);
}

function duration(from, to) {
  if (!from || !to) return '—';
  const minutes = Math.round((new Date(to) - new Date(from)) / 60000);
  if (minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
