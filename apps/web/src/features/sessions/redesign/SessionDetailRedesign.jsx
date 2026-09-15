import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  getSession, clockInSession, clockOutSession, submitSession, freezeSession,
  returnSession, cancelSession, amendSession,
} from '@/api/client';
import { useToast } from '@/components';
import { Badge, Button, Icon, Modal, Field, Textarea, Select } from '@/ui';
import { statusLabel, sessionStatusText, formatTime, formatDate } from '@/lib/format';
import { useAuthStore, useOrgTimezone } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { SESSION_DETAIL_STALE_MS } from './CompanySessionsPage.jsx';

/**
 * Session detail — a premium workflow around the EXISTING lifecycle backend
 * (the state machine is untouched). It renders a status timeline, a populated
 * business-record card and a role-aware action footer whose gates mirror
 * SESSION_TRANSITIONS exactly:
 *
 *   DRAFT → (clock in) IN_PROGRESS → (clock out, submit) SUBMITTED
 *         → (approve) FROZEN | (return) RETURNED → …  ; FROZEN → (amend)
 *
 * ROOT-CAUSE FIX (spec §3–§6): GET /v1/sessions/:id returns
 * `{ session, dataPoints, child, appointment, payroll }`. This page previously
 * read the fields off the wrapper object directly (`data.clientId`,
 * `data.startedAt`…), which are all undefined — every field rendered blank.
 * We now read the real `data.session` for the persisted times/status/note, and
 * the resolved `child` / `appointment` / `payroll` context the API composes
 * from the related records, so the detail shows meaningful business data (child
 * name, BCBA/RBT, scheduled window, actual start/end, duration, units,
 * authorization label, payroll) with no database identifiers.
 *
 * The "Signatures & verification" card was removed from this BCBA-facing screen
 * per spec §7; the signature/EVV backend is untouched and remains available to
 * the guardian and technician surfaces.
 */
const FLOW = ['DRAFT', 'IN_PROGRESS', 'SUBMITTED', 'FROZEN'];
// Business-friendly status labels come from the ONE shared helper (statusLabel):
// FROZEN → "Approved", IN_PROGRESS → "In progress", DRAFT → "Scheduled".

/*
 * Session times are INSTANTS and are always read on the ORGANIZATION's business
 * calendar (`timeZone`), never the browser's. A session recorded for 10:15 AM –
 * 11:45 AM in the org's zone reads exactly that for every viewer, wherever
 * their device clock is set. The browser zone is only a fallback when the
 * organization has no timezone.
 */
/** "09/13/2026" — human date, never an ISO string. */
function dateText(v, timeZone) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : formatDate(d, timeZone);
}
/** "10:15 AM" clock time (minute resolution — the recorded clock, no seconds). */
function clockText(v, timeZone) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : formatTime(d, timeZone);
}
/**
 * "09/13/2026 · 10:15 AM – 11:45 AM" scheduled window. A DATE-ONLY appointment
 * (`timeSet === false`) shows just its date — never a fabricated 12:00 AM.
 */
function windowText(startAt, endAt, timeZone, timeSet = true) {
  const day = dateText(startAt, timeZone);
  if (!day) return null;
  if (timeSet === false) return day;
  const s = clockText(startAt, timeZone);
  const e = clockText(endAt, timeZone);
  if (!s) return null;
  return e ? `${day} · ${s} – ${e}` : `${day} · ${s}`;
}
/** Actual worked duration "57m 19s" / "1h 02m 14s" from start/end. */
function durationText(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s` : `${m}m ${String(s).padStart(2, '0')}s`;
}
/** Whole worked minutes → "1h 05m" / "45m". The BCBA sees time, never money. */
function workedText(mins) {
  if (mins === null || mins === undefined) return '—';
  const m = Math.max(0, Math.round(Number(mins)));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

async function capturePlace() {
  if (!('geolocation' in navigator)) return {};
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000 }));
    return { location: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy } };
  } catch { return {}; }
}

export function SessionDetailRedesign() {
  const { sessionId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const timeZone = useOrgTimezone() || undefined;
  const roles = useAuthStore((st) => st.principal?.roles) ?? [];
  const shell = shellForRoles(roles);
  // WHY THE AUTH STATUS IS READ, NOT JUST THE PERMISSIONS.
  //
  // `principal` is null until the auth bootstrap resolves, which is
  // indistinguishable from "this user may do nothing" if only permissions are
  // read — the page would render with every action silently missing. The page
  // waits for the principal the same way it waits for the session. The backend
  // remains the authority — this only decides which affordances to draw.
  const { can, ready: authReady } = usePermissions();
  const canWrite = can('sessions.write');
  const canReview = can('sessions.review');

  const [dialog, setDialog] = useState(null); // 'return' | 'amend' | 'cancel'
  const [comment, setComment] = useState('');
  const [reasonCode, setReasonCode] = useState('CLIENT_CANCEL');

  // Deep-linkable: the session comes from its canonical endpoint by the route id
  // alone — never from the list, navigation state or local selection. The same
  // key and freshness window as the list's hover prefetch, so a warmed detail is
  // not fetched twice; lifecycle actions invalidate it immediately.
  const query = useQuery({ queryKey: ['session', sessionId], queryFn: () => getSession(sessionId), enabled: Boolean(sessionId), staleTime: SESSION_DETAIL_STALE_MS });

  const done = (msg) => { qc.invalidateQueries({ queryKey: ['session', sessionId] }); qc.invalidateQueries({ queryKey: ['sessions'] }); toast.push(msg); setDialog(null); setComment(''); };
  const fail = (err) => { const m = err?.response?.data?.error?.message; toast.push(m && !/^[A-Z]+-\d+$/.test(m) ? m : 'We couldn’t do that just now.', 'negative'); };

  const clockIn = useMutation({ mutationFn: async () => clockInSession(sessionId, await capturePlace()), onSuccess: () => done('Clocked in.'), onError: fail });
  const clockOut = useMutation({ mutationFn: async () => clockOutSession(sessionId, await capturePlace()), onSuccess: () => done('Clocked out.'), onError: fail });
  const submit = useMutation({ mutationFn: () => submitSession(sessionId), onSuccess: () => done('Submitted for review.'), onError: fail });
  const approve = useMutation({ mutationFn: () => freezeSession(sessionId), onSuccess: () => done('Session approved.'), onError: fail });
  const sendBack = useMutation({ mutationFn: () => returnSession(sessionId, comment), onSuccess: () => done('Returned to technician.'), onError: fail });
  const cancel = useMutation({ mutationFn: () => cancelSession(sessionId, { reasonCode, ...(comment ? { note: comment } : {}) }), onSuccess: () => done('Session cancelled.'), onError: fail });
  const amend = useMutation({ mutationFn: () => amendSession(sessionId, { reason: comment }), onSuccess: () => done('Amendment recorded.'), onError: fail });

  const backTo = { to: '/sessions', label: shell === 'bcba' ? 'Back to Review Queue' : 'Back to Sessions' };

  // Wait for BOTH the session and the principal.
  if (query.isLoading || !authReady) return <DetailSkeleton backTo={backTo} />;
  if (query.isError) {
    const status = query.error?.response?.status;
    const notFound = status === 404 || status === 403;
    return (
      <div className="rx-sd">
        <Link to={backTo.to} className="rx-sp__back"><Icon.Return size={15} /> {backTo.label}</Link>
        <div className="rx-sd__state" role="alert">
          <span className="rx-sd__state-icon" aria-hidden="true"><Icon.Clipboard size={22} /></span>
          <h1 className="rx-sd__state-title">{notFound ? 'Session not found' : 'We couldn’t load this session'}</h1>
          <p className="rx-sd__muted">{notFound ? 'This session doesn’t exist or isn’t available to you.' : 'Check your connection and try again.'}</p>
          {notFound ? <Link className="rx-btn rx-btn--primary" to={backTo.to}>{backTo.label}</Link> : <Button onClick={() => query.refetch()}>Try again</Button>}
        </div>
      </div>
    );
  }

  // Read the REAL session and the resolved display context.
  const data = query.data ?? {};
  const s = data.session ?? {};
  const appt = data.appointment ?? null;
  const child = data.child ?? null;
  const payroll = data.payroll ?? null;
  const status = s.status;
  const busy = [clockIn, clockOut, submit, approve, sendBack, cancel, amend].some((m) => m.isPending);

  const canClockIn = canWrite && status === 'DRAFT' && !s.clockInAt;
  const canClockOut = canWrite && status === 'IN_PROGRESS' && !s.clockOutAt;
  const canSubmit = canWrite && ['IN_PROGRESS', 'RETURNED'].includes(status) && Boolean(s.clockOutAt);
  const canCancel = canWrite && ['DRAFT', 'IN_PROGRESS', 'RETURNED'].includes(status);
  const canApprove = canReview && status === 'SUBMITTED';
  const canSendBack = canReview && status === 'SUBMITTED';
  const canAmend = canReview && status === 'FROZEN';
  const anyAction = canClockIn || canClockOut || canSubmit || canApprove || canSendBack || canAmend || canCancel;

  const activeIdx = FLOW.indexOf(status === 'RETURNED' ? 'IN_PROGRESS' : status);

  // Names (never ids), resolved SERVER-SIDE via display.*; a role absent from
  // the response is simply not rendered, so this cannot widen access.
  const display = data.display ?? {};
  const childName = display.childName
    || (child && (child.preferredName || [child.firstName, child.lastName].filter(Boolean).join(' ')))
    || 'Not available';
  const bcbaName = display.bcbaName || (appt?.bcbaId ? 'Not available' : null);
  const rbtName = display.rbtName || (appt?.rbtId ? 'Not available' : null);
  const planName = display.treatmentPlanName || null;
  const auth = appt?.selectedAuthorization || appt?.authorizations?.[0] || null;
  const authText = auth ? (auth.label || auth.serviceCode || 'Authorization') : null;

  const scheduled = windowText(appt?.startAt, appt?.endAt, timeZone, appt?.timeSet);
  const duration = durationText(s.startedAt, s.endedAt);
  const workPeriods = Array.isArray(s.intervals) ? s.intervals.filter((iv) => iv && iv.startedAt) : [];
  // The persisted clock only — never the appointment window, "now" or midnight.
  const clockedIn = clockText(s.clockInAt, timeZone) || clockText(s.startedAt, timeZone);
  const clockedOut = clockText(s.clockOutAt, timeZone) || clockText(s.endedAt, timeZone);
  // Worked Time: the authoritative SessionTimeRecord minutes when present.
  const worked = payroll?.workedMinutes != null ? workedText(payroll.workedMinutes) : (duration || '—');
  const sessionDay = scheduled || dateText(s.startedAt, timeZone);
  const note = (s.narrative && String(s.narrative).trim()) || '';
  const doc = data.documentation ?? {};
  const docHasContent = [doc.what, doc.how, doc.childResponse].some((v) => v && String(v).trim());
  const selectedAuths = (appt?.selectedAuthorizations ?? []).filter((a) => a && (a.memo || a.label));
  const tone = STATUS_TONE[status] ?? 'draft';

  return (
    <div className="rx-sd">
      <Link to={backTo.to} className="rx-sp__back"><Icon.Return size={15} /> {backTo.label}</Link>

      <header className={`rx-sd__hero rx-sd__hero--${tone}`}>
        <div className="rx-sd__hero-main">
          <span className="rx-sd__avatar" aria-hidden="true">{initialsOf(childName)}</span>
          <div className="rx-sd__hero-text">
            <div className="rx-sd__eyebrow-row">
              <span className="rx-sd__eyebrow">Session</span>
              <Badge tone={tone} status={status}>{sessionStatusText(s)}</Badge>
              {s.source === 'MANUAL' && <Badge tone="info" dot={false}>Manual entry</Badge>}
            </div>
            <h1 className="rx-sd__title">{childName}</h1>
            {sessionDay ? <p className="rx-sd__when"><Icon.Calendar size={14} aria-hidden="true" />{sessionDay}</p> : null}
          </div>
        </div>
        <div className="rx-sd__worked">
          <span>Worked Time</span>
          <strong>{worked}</strong>
        </div>
      </header>

      {/* Review timeline — a manual entry is completed work, not a review workflow. */}
      {s.source !== 'MANUAL' && (
        <ol className="rx-sd__flow" aria-label="Session progress">
          {FLOW.map((st, i) => {
            const state = i < activeIdx ? 'done' : i === activeIdx ? 'current' : 'todo';
            return (
              <li key={st} className={`rx-sd__flow-step is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="rx-sd__flow-dot" aria-hidden="true">{state === 'done' ? <Icon.Check size={12} /> : i + 1}</span>
                {statusLabel(st)}
              </li>
            );
          })}
          {status === 'RETURNED' && <li className="rx-sd__flow-note">Returned for correction</li>}
        </ol>
      )}

      <dl className="rx-sd__facts">
        <Fact tone="violet" icon={Icon.Chart} label="Units" value={(appt?.units ?? null) !== null ? String(appt.units) : '—'} />
        <Fact tone="blue" icon={Icon.Clock} label="Clocked in" value={clockedIn || (status === 'DRAFT' ? 'Not started' : '—')} />
        <Fact tone="amber" icon={Icon.Clock} label="Clocked out" value={clockedOut || (status === 'IN_PROGRESS' && !s.endedAt ? 'Still in progress' : '—')} />
        <Fact tone="teal" icon={Icon.CheckCircle} label="Status" value={sessionStatusText(s)} />
      </dl>

      <div className="rx-sd__layout">
        <div className="rx-sd__col">
          {/* SESSION OVERVIEW — the one timing vocabulary: Clocked in, Clocked out, Worked Time. */}
          <Section title="Session overview" icon={Icon.Clipboard}>
            <dl className="rx-sd__rows">
              <Row label="Client" value={childName} />
              {scheduled && <Row label="Session date" value={scheduled} />}
              <Row label="Clocked in" value={clockedIn || (status === 'DRAFT' ? 'Not started' : '—')} />
              <Row label="Clocked out" value={clockedOut || (status === 'IN_PROGRESS' && !s.endedAt ? 'Still in progress' : '—')} />
              <Row label="Worked Time" value={worked} />
              {workPeriods.length > 1 && <Row label="Work periods" value={String(workPeriods.length)} />}
            </dl>
          </Section>

          {(bcbaName || rbtName) && (
            <Section title="Care team" icon={Icon.Users}>
              <ul className="rx-sd__people">
                {bcbaName && <Person role="BCBA" name={bcbaName} />}
                {rbtName && <Person role="RBT" name={rbtName} />}
              </ul>
            </Section>
          )}

          {(authText || (appt?.units ?? null) !== null) && (
            <Section title="Authorization" icon={Icon.Shield}>
              <dl className="rx-sd__rows">
                {authText && <Row label="Authorization" value={authText} />}
                {(appt?.units ?? null) !== null && <Row label="Units" value={appt.units} />}
              </dl>
            </Section>
          )}

          {workPeriods.length > 0 && (
            <Section title="Work periods" hint="Each time this session was started and stopped" icon={Icon.Clock}>
              <dl className="rx-sd__rows">
                {workPeriods.map((iv, i) => (
                  <Row
                    key={`${iv.startedAt}-${i}`}
                    label={`Work period ${i + 1}`}
                    value={iv.endedAt
                      ? `${clockText(iv.startedAt, timeZone)} – ${clockText(iv.endedAt, timeZone)} · ${workedText(iv.workedMinutes)}`
                      : `${clockText(iv.startedAt, timeZone)} – in progress`}
                  />
                ))}
              </dl>
            </Section>
          )}
        </div>

        <div className="rx-sd__col">
          {planName && (
            <Section title="Treatment Plan" icon={Icon.Doc}>
              <p className="rx-sd__plan">{planName}</p>
            </Section>
          )}

          {/* The session's own record — distinct from the treatment plan and the appointment note. */}
          <Section title="Session memo" hint="Written by the clinician during this session" icon={Icon.Doc}>
            <p className={`rx-sd__text${note ? '' : ' is-empty'}`}>{note || 'No session memo was recorded.'}</p>
          </Section>

          {docHasContent && (
            <Section title="Session documentation" hint="What was done this session — separate from the treatment plan" icon={Icon.Clipboard}>
              <div className="rx-sd__docs">
                <DocBlock label="What did you work on?" value={doc.what} />
                <DocBlock label="How was the intervention implemented?" value={doc.how} />
                <DocBlock label="How did the client respond?" value={doc.childResponse} />
              </div>
            </Section>
          )}

          {selectedAuths.length > 0 && (
            <Section title="Authorizations & memos" hint="Each authorization selected at completion" icon={Icon.Shield}>
              <div className="rx-sd__docs">
                {selectedAuths.map((a) => (
                  <DocBlock key={a.id} label={a.label || a.serviceCode || 'Authorization'} value={a.memo} emptyText="No memo for this authorization." />
                ))}
              </div>
            </Section>
          )}

          {s.returnComment && (
            <Section title="Returned for correction" icon={Icon.Return}>
              <p className="rx-sd__text">{s.returnComment}</p>
            </Section>
          )}
        </div>
      </div>

      {anyAction && (
        <div className="rx-sd__actions">
          {canClockIn && <Button icon={Icon.Clock} onClick={() => clockIn.mutate()} loading={clockIn.isPending} disabled={busy}>Clock in</Button>}
          {canClockOut && <Button icon={Icon.Clock} onClick={() => clockOut.mutate()} loading={clockOut.isPending} disabled={busy}>Clock out</Button>}
          {canSubmit && <Button icon={Icon.Check} onClick={() => submit.mutate()} loading={submit.isPending} disabled={busy}>Submit for review</Button>}
          {canApprove && <Button icon={Icon.CheckCircle} onClick={() => approve.mutate()} loading={approve.isPending} disabled={busy}>Approve</Button>}
          {canSendBack && <Button variant="ghost" icon={Icon.Return} onClick={() => setDialog('return')} disabled={busy}>Return for correction</Button>}
          {canAmend && <Button variant="ghost" icon={Icon.Doc} onClick={() => setDialog('amend')} disabled={busy}>Amend</Button>}
          {canCancel && <Button variant="ghost" className="rx-sd__danger" onClick={() => setDialog('cancel')} disabled={busy}>Cancel session</Button>}
        </div>
      )}

      {/* Return / amend dialog */}
      <Modal open={dialog === 'return' || dialog === 'amend'} onClose={() => setDialog(null)}
        title={dialog === 'amend' ? 'Amend session' : 'Return for correction'}
        description={dialog === 'amend' ? 'Record a reason for the amendment.' : 'Tell the technician what needs fixing.'}
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
          <Button onClick={() => (dialog === 'amend' ? amend : sendBack).mutate()} loading={amend.isPending || sendBack.isPending} disabled={!comment.trim()}>
            {dialog === 'amend' ? 'Record amendment' : 'Return session'}</Button></>}>
        <Field label="Comment" required><Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a clear, specific note…" /></Field>
      </Modal>

      {/* Cancel dialog */}
      <Modal open={dialog === 'cancel'} onClose={() => setDialog(null)} title="Cancel session" description="This cannot be undone." size="sm"
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Keep session</Button>
          <Button className="rx-btn--danger" style={{ color: '#fff' }} onClick={() => cancel.mutate()} loading={cancel.isPending}>Cancel session</Button></>}>
        <Field label="Reason">
          <Select value={reasonCode} onChange={setReasonCode} searchable={false}
            options={[{ value: 'CLIENT_CANCEL', label: 'Client cancelled' }, { value: 'STAFF_CANCEL', label: 'Staff cancelled' }, { value: 'NO_SHOW', label: 'No show' }, { value: 'OTHER', label: 'Other' }]} />
        </Field>
        <Field label="Note (optional)"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} /></Field>
      </Modal>
    </div>
  );
}

const STATUS_TONE = { DRAFT: 'draft', IN_PROGRESS: 'pending', SUBMITTED: 'info', RETURNED: 'denied', FROZEN: 'approved', AMENDED: 'approved', CANCELLED: 'denied' };
const initialsOf = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '·';

function Section({ title, hint, icon: IconCmp, children }) {
  return (
    <section className="rx-sd__card" aria-label={title}>
      <div className="rx-sd__card-head">
        <h2 className="rx-sd__card-title">{IconCmp ? <IconCmp size={16} aria-hidden="true" /> : null}{title}</h2>
        {hint && <p className="rx-sd__card-hint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Fact({ tone, icon: IconCmp, label, value }) {
  return (
    <div className={`rx-sd__fact rx-sd__fact--${tone}`}>
      <span className="rx-sd__fact-icon" aria-hidden="true"><IconCmp size={16} /></span>
      <div><dt>{label}</dt><dd>{value}</dd></div>
    </div>
  );
}

function Person({ role, name }) {
  return (
    <li className="rx-sd__person">
      <span className={`rx-sd__person-avatar rx-sd__person-avatar--${role.toLowerCase()}`} aria-hidden="true">{initialsOf(name)}</span>
      <span className="rx-sd__person-text"><strong>{name}</strong><i className={`rx-sd__role rx-sd__role--${role.toLowerCase()}`}>{role}</i></span>
    </li>
  );
}

function DetailSkeleton({ backTo }) {
  return (
    <div className="rx-sd" aria-busy="true" aria-label="Loading session">
      <Link to={backTo.to} className="rx-sp__back"><Icon.Return size={15} /> {backTo.label}</Link>
      <div className="rx-skel" style={{ height: 118, borderRadius: 20 }} />
      <div className="rx-sd__facts">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel" style={{ height: 68, borderRadius: 14 }} />)}</div>
      <div className="rx-sd__layout"><div className="rx-skel" style={{ height: 300, borderRadius: 18 }} /><div className="rx-skel" style={{ height: 300, borderRadius: 18 }} /></div>
    </div>
  );
}

function Row({ label, value }) {
  return <div className="rx-sd__row"><dt>{label}</dt><dd>{value}</dd></div>;
}

// A labelled multiline block for free-text documentation / memos (spec §11/§23).
function DocBlock({ label, value, emptyText = 'Not documented.' }) {
  const text = value && String(value).trim();
  return (
    <div className="rx-sd__doc">
      <div className="rx-sd__doc-label">{label}</div>
      <p className={`rx-sd__text${text ? '' : ' is-empty'}`}>{text || emptyText}</p>
    </div>
  );
}

export default SessionDetailRedesign;
