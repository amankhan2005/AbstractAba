import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { formatTime } from '@/lib/format';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Card, Button, Badge, Icon, Modal, Select, Textarea, Field, EmptyState } from '@/ui';
import {
  getBcbaChildDetail, startBcbaSession, stopBcbaSession, completeBcbaSession,
  saveBcbaSessionDocumentation,
} from '@/api/client';
import { useSessionTimer } from './useSessionTimer.js';
import { useOrgTimezone } from '@/auth/store';
import { isStartableNow, startabilityLabel, isExpiredAppointment, occurrenceText } from '@/lib/appointment.js';
import { useStartWindowClock } from './useStartWindowClock.js';

/**
 * ---------------------------------------------------------------------------
 * SHARED BCBA active-session UI (spec §C, §K, §1, Phases 3–7, 17, 30).
 *
 * The active-session hero and the weekly-progress card are rendered in TWO
 * places — the Session Panel and the BCBA Dashboard — so they live here once
 * instead of being copy-pasted. Reusing this single component keeps the
 * "one canonical active session, one server-anchored timer" guarantee: both
 * surfaces read the same running card from useBcbaActiveSession and reconstruct
 * elapsed time from the server-persisted startedAt. Nothing here starts a
 * second session, a second timer, or a second time record.
 *
 * Every value shown is human-readable: the child's NAME (never an id), a human
 * appointment window and clock time (never an ISO string), and the resolved
 * authorization label (never a `svc:` id).
 * ---------------------------------------------------------------------------
 */

/** Time-of-day greeting from the local clock (spec §1). */
export function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function isToday(v) {
  if (!v) return false;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/**
 * "Today · 9:50 PM – 10:50 PM" — human window, never an ISO string (spec §B).
 * When `timeSet === false` the appointment is DATE-ONLY (booked without a clock
 * time): show just the day, never a fabricated time window.
 */
export function windowText(startAt, endAt, timeSet = true) {
  if (!startAt) return '—';
  const s = new Date(startAt);
  const day = isToday(s) ? 'Today' : s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (timeSet === false) return day;
  const t = (v) => formatTime(v);
  return endAt ? `${day} · ${t(startAt)} – ${t(endAt)}` : `${day} · ${t(startAt)}`;
}

/** "9:51:12 PM" — clock time to the second, never an ISO string (spec §B/§I). */
export function clockTime(v) {
  return v ? formatTime(v) : '—'; // no seconds (Phase 4 §13)
}

/**
 * The active-session hero (spec §C). Pulls the permission-scoped child overview
 * for the running appointment so it can show the resolved authorization label
 * (never a `svc:` id) alongside the live timer. The server authorizes by
 * appointment.bcbaId, so this only ever shows the BCBA's own child.
 *
 * @param {object}   card       the running panel card (from useBcbaActiveSession)
 * @param {string}   childName  resolved child display name (never an id)
 * @param {Function} onStop     invoked by the Stop button — the caller owns the
 *                              canonical stop/complete flow (no duplicate here)
 * @param {boolean}  stopping   Stop button loading state
 */
export function ActiveSessionHero({ card, childName, onStop, stopping, fetchChildDetail = getBcbaChildDetail, detailKey = 'bcba', saveDocumentation = saveBcbaSessionDocumentation, variant = 'bcba' }) {
  // The running session's own scheduled occurrence (its business date), not the range start.
  const heroTz = useOrgTimezone();
  const navigate = useNavigate();
  // Anchor on the CURRENTLY RUNNING work period, falling back to the session
  // start for sessions recorded before work periods existed. Anchoring on
  // card.startedAt would count any earlier break as elapsed time.
  const timerAnchor = card.activePeriodStartedAt ?? card.startedAt;
  const { text, ready } = useSessionTimer(timerAnchor, Boolean(timerAnchor));
  const detail = useQuery({
    queryKey: [detailKey, 'child-detail', card.appointmentId],
    queryFn: () => fetchChildDetail(card.appointmentId),
  });
  const auths = detail.data?.appointment?.authorizations ?? [];
  const authText = auths.length ? (auths[0].label || auths[0].serviceCode || 'Authorization') : null;

  return (
    <Card className="rx-activesession" pad>
      <div className="rx-as">
        <div className="rx-as__who">
          <Badge tone="pending">Session in progress</Badge>
          <div className="rx-as__name">{childName}</div>
          <div className="rx-as__meta">{occurrenceText(card, heroTz, new Date(), { todayLabel: true })}</div>
          {authText && <div className="rx-as__meta">Authorization: <strong>{authText}</strong></div>}
        </div>

        <div className="rx-as__clock">
          {/* Never render a literal 0:00 before the persisted start time is
              known — that reads as "your timer reset", not "still loading". */}
          <div
            role="status"
            aria-live="polite"
            aria-label={ready ? `Session running for ${text}` : 'Loading the active session'}
            className={`rx-as__timer${ready ? '' : ' is-loading'}`}
          >
            {ready ? text : 'Loading active session…'}
          </div>
          {/* The start time comes straight from the card, so it is shown even
              while the live timer has no usable anchor. */}
          {card.startedAt && <div className="rx-as__meta">Session start time {clockTime(card.startedAt)}</div>}
          {card.intervalCount > 0 && (
            <div className="rx-as__meta">Work period {card.intervalCount + 1} · {workedText(card.workedMinutes)} worked so far</div>
          )}
        </div>

        <div className="rx-as__actions">
          <Button icon={Icon.User} variant="ghost" onClick={() => navigate(`/clients/${card.clientId}`)}>Open session</Button>
          <Button icon={Icon.CheckCircle} variant="danger" onClick={onStop} loading={stopping}>Stop session</Button>
        </div>
      </div>

      {/* Live clinical input while the session runs. The treatment plan is
          read-only for both roles; WHICH input fields appear is the role's
          workflow (BCBA: documentation + memo, RBT: memo only). */}
      <SessionDocumentationPanel
        appointmentId={card.appointmentId}
        activePlan={detail.data?.activePlan ?? null}
        documentation={detail.data?.session?.documentation ?? null}
        memo={detail.data?.session?.memo ?? null}
        loading={detail.isLoading}
        save={saveDocumentation}
        onSaved={() => detail.refetch()}
        variant={variant}
      />
    </Card>
  );
}

/**
 * SESSION DOCUMENTATION — captured live during an ACTIVE session (spec §1–§8).
 *
 * Three plain clinical fields (What / How / Child response) that belong to THIS
 * session, saved explicitly with one bounded request (no per-keystroke traffic,
 * §16). The treatment plan is shown as READ-ONLY context above the fields when
 * one applies; when none does, a friendly note replaces it and documentation is
 * still fully available (§5). Saving never touches the clock, status or worked
 * time — that is enforced on the server. The save state is honest: "Saved" only
 * appears after the backend confirms persistence (§7).
 */
/**
 * In-session clinical input. ONE component, TWO role workflows — deliberately
 * not two components, so the treatment-plan context, the save/retry states and
 * the persistence contract cannot drift apart between roles.
 *
 *   variant="bcba"  Session Documentation (what / how / client response) AND a
 *                   Session Memo. The richer workflow; feeds Import from
 *                   Documentation at completion.
 *   variant="rbt"   Session Memo ONLY, plus the read-only treatment plan. The
 *                   RBT workflow is intentionally simpler — the three clinical
 *                   documentation fields are the BCBA's, and the server rejects
 *                   them from an RBT regardless of what this renders.
 *
 * The memo is stored in the session's existing sealed narrative field for both
 * roles, so it flows into the existing session-note workflow unchanged.
 */
export function SessionDocumentationPanel({ appointmentId, activePlan, documentation, memo: savedMemo, loading, save, onSaved, variant = 'bcba' }) {
  const [what, setWhat] = useState('');
  const [how, setHow] = useState('');
  const [childResponse, setChildResponse] = useState('');
  const [memo, setMemo] = useState('');
  const showDocumentation = variant !== 'rbt';
  // Hydrate from the persisted documentation once it arrives (and on reload /
  // navigation, since this remounts and refetches). Only overwrite from the
  // server when the user has no unsaved edits.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    if (documentation) {
      setWhat(documentation.what ?? '');
      setHow(documentation.how ?? '');
      setChildResponse(documentation.childResponse ?? '');
    }
    if (savedMemo !== undefined) setMemo(savedMemo ?? '');
  }, [documentation, savedMemo, dirty]);

  const edit = (setter) => (e) => { setDirty(true); setter(e.target?.value ?? e); };

  const saveM = useMutation({
    // ONE bounded request. An RBT sends only the memo — never the BCBA's
    // documentation fields, which the server would reject anyway.
    mutationFn: () => save(appointmentId, showDocumentation ? { what, how, childResponse, memo } : { memo }),
    onSuccess: () => { setDirty(false); if (onSaved) onSaved(); },
  });

  const planTitle = activePlan?.title || activePlan?.name || null;
  const planGoals = (activePlan?.goals ?? []).filter((g) => g?.description);
  const planPrograms = (activePlan?.programs ?? []).filter((p) => p?.name);

  return (
    <div className="rx-sdoc">
      <div className="rx-sdoc__head">
        <h3 className="rx-sdoc__title">{showDocumentation ? 'Session Documentation' : 'Session Memo'}</h3>
        <SaveState state={saveM.isPending ? 'saving' : saveM.isError ? 'error' : (!dirty && saveM.isSuccess) ? 'saved' : 'idle'} onRetry={() => saveM.mutate()} />
      </div>

      {/* Treatment plan CONTEXT — read-only (spec §3/§10/§14). */}
      {planTitle ? (
        <div className="rx-sdoc__plan" role="note">
          <Icon.Clipboard size={16} aria-hidden="true" />
          <span>
            Treatment plan: <strong>{planTitle}</strong>
            {(activePlan?.goalCount != null || activePlan?.programCount != null) && (
              <> — {activePlan.goalCount ?? 0} goal{(activePlan.goalCount ?? 0) === 1 ? '' : 's'}, {activePlan.programCount ?? 0} program{(activePlan.programCount ?? 0) === 1 ? '' : 's'}</>
            )}
            . View-only clinical guidance — your {showDocumentation ? 'documentation' : 'memo'} doesn’t change the plan.
          </span>
        </div>
      ) : (
        <div className="rx-sdoc__plan" role="note">
          <Icon.Clipboard size={16} aria-hidden="true" />
          <span>No active Treatment Plan is available for this session. You can still {showDocumentation ? 'document' : 'write a memo for'} today’s session below.</span>
        </div>
      )}

      {/* The plan's goals and programs, READ-ONLY — what to work on, with no
          edit affordance (plans are authored in the treatment-plan module). */}
      {planTitle && (planGoals.length > 0 || planPrograms.length > 0) && (
        <div className="rx-sdoc__guidance">
          <div className="rx-sdoc__guidance-title">Treatment plan guidance (view only)</div>
          <div className="rx-sdoc__guidance-cols">
            {planGoals.length > 0 && (
              <div>
                <div className="rx-sdoc__guidance-k">Goals</div>
                <ul>{planGoals.map((g) => <li key={g.id}>{g.description}</li>)}</ul>
              </div>
            )}
            {planPrograms.length > 0 && (
              <div>
                <div className="rx-sdoc__guidance-k">Programs</div>
                <ul>{planPrograms.map((pr) => <li key={pr.id}>{pr.name}</li>)}</ul>
              </div>
            )}
          </div>
        </div>
      )}

      <div className={`rx-sdoc__fields${showDocumentation ? ' rx-sdoc__fields--doc' : ''}`}>
        {showDocumentation && (
          <>
            <Field label="What did you work on today?">
              <Textarea value={what} onChange={edit(setWhat)} placeholder="e.g. Practiced requesting preferred items" rows={3} disabled={loading} />
            </Field>
            <Field label="How was the intervention implemented?">
              <Textarea value={how} onChange={edit(setHow)} placeholder="e.g. Used prompting and reinforcement per the plan" rows={3} disabled={loading} />
            </Field>
            <Field label="How did the client respond?">
              <Textarea value={childResponse} onChange={edit(setChildResponse)} placeholder="e.g. Client independently requested items several times" rows={3} disabled={loading} />
            </Field>
          </>
        )}
        <Field label="Session Memo">
          <Textarea
            value={memo}
            onChange={edit(setMemo)}
            placeholder="e.g. Worked on requesting during snack time. Client was engaged throughout."
            rows={showDocumentation ? 3 : 5}
            disabled={loading}
          />
        </Field>
      </div>

      <div className="rx-sdoc__actions">
        <Button icon={Icon.Check} onClick={() => saveM.mutate()} loading={saveM.isPending} disabled={loading || !dirty}>
          {showDocumentation ? 'Save documentation' : 'Save memo'}
        </Button>
      </div>
    </div>
  );
}

function SaveState({ state, onRetry }) {
  if (state === 'saving') return <span className="rx-row__meta">Saving…</span>;
  if (state === 'saved') return <span className="rx-sdoc__saved" role="status"><Icon.CheckCircle size={16} /> Saved</span>;
  if (state === 'error') return <button type="button" className="rx-sdoc__retry" onClick={onRetry}>Couldn’t save — Retry</button>;
  return null;
}

/** THIS WEEK progress (spec §K/§L). Values come from the server; nothing hardcoded. */
export function WeeklyProgress({ data }) {
  const pct = Math.max(0, Math.min(100, data.percent ?? 0));
  return (
    <Card title="This week" hint={data.overtime ? 'Weekly goal reached' : `${data.sessionCount ?? 0} session${(data.sessionCount ?? 0) === 1 ? '' : 's'} this week`}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'baseline', marginBottom: 12 }}>
        <div><span style={{ fontSize: 26, fontWeight: 800 }}>{data.completedText}</span> <span className="rx-row__meta">completed</span></div>
        <div className="rx-row__meta">{data.targetText} weekly goal</div>
        {data.remainingText && <div className="rx-row__meta">{data.remainingText} remaining</div>}
      </div>
      <div aria-hidden style={{ height: 10, borderRadius: 999, background: 'var(--rx-line, #e5e7eb)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: 'var(--rx-accent, #6d28d9)', transition: 'width .4s ease' }} />
      </div>
      <div className="rx-row__meta" role="status" style={{ marginTop: 6 }}>{pct}% of your {data.targetText} goal</div>
    </Card>
  );
}

/** Panel status → a labelled badge. Shared by both the BCBA and RBT panels. */
export function statusBadge(status) {
  const map = {
    SCHEDULED: { tone: 'draft', label: 'Scheduled' },
    IN_PROGRESS: { tone: 'pending', label: 'In progress' },
    STOPPED: { tone: 'pending', label: 'Stopped' },
    COMPLETED: { tone: 'approved', label: 'Completed' },
    FROZEN: { tone: 'approved', label: 'Completed' },
    AMENDED: { tone: 'approved', label: 'Completed' },
    CANCELLED: { tone: 'draft', label: 'Cancelled' },
  }[status] || { tone: 'draft', label: status };
  return <Badge tone={map.tone}>{map.label}</Badge>;
}

function workedText(mins) {
  if (mins === null || mins === undefined) return '—';
  const m = Math.max(0, Math.round(Number(mins)));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/**
 * The stop → authorization → memo → complete modal, generalized so BOTH panels
 * reuse the SAME completion UI and flow. The caller injects `complete` (the
 * BCBA or RBT complete API), so no duplicate completion system exists. The
 * authorization list is the eligible set the server returned for THIS
 * appointment; the memo is optional free text persisted as the sealed session
 * narrative. Worked time is the authoritative value from the created
 * SessionTimeRecord — never a browser total.
 */
export function SessionCompletionModal({ payload, childName, complete, onClose, onCompleted }) {
  const eligible = (payload.eligibleAuthorizations || []).map((a) => (
    typeof a === 'string' ? { id: a, label: a } : { id: a.id, label: a.label || a.serviceCode || 'Authorization' }
  ));
  // One selection state per eligible authorization: whether it's selected and
  // its OWN memo (spec §22/§23). Pre-select the previously-chosen primary, or
  // the only authorization when there is exactly one, so the common case is one
  // tap. Each memo is independent and persists against its own authorization.
  const [sel, setSel] = useState(() => {
    const init = {};
    for (const a of eligible) {
      const preselect = a.id === payload.selectedAuthorizationId || eligible.length === 1;
      init[a.id] = { selected: preselect, memo: '' };
    }
    return init;
  });
  const [result, setResult] = useState(null);

  const chosen = eligible.filter((a) => sel[a.id]?.selected);
  const toggle = (id) => setSel((s) => ({ ...s, [id]: { ...s[id], selected: !s[id]?.selected } }));
  const setMemo = (id, memo) => setSel((s) => ({ ...s, [id]: { ...s[id], memo, confirmImport: false } }));
  const setConfirmImport = (id, v) => setSel((s) => ({ ...s, [id]: { ...s[id], confirmImport: v } }));

  // "Import from Session Note" copies the CURRENTLY SAVED Session Memo into the
  // per-authorization memo for editing. Never a new model — a UI copy into the
  // existing field, with an existing memo preserved until the user confirms.
  //
  // It imports the SESSION MEMO, not the three documentation questions. Those
  // are Session Documentation: a separate BCBA concept with its own fields and
  // its own place in the record. Pasting "What did you work on? … How was the
  // intervention implemented? …" into an authorization memo duplicated clinical
  // documentation into a billing-facing field and made the memo box unreadable.
  //
  //   Session Documentation → what / how / client response  (clinical record)
  //   Session Memo          → the clinician's session note
  //   Authorization memo    → note for THIS authorization, seeded from the memo
  const sessionNoteText = (payload.memo ?? '').trim();
  const hasNote = sessionNoteText.length > 0;
  const importInto = (id) => {
    if ((sel[id]?.memo ?? '').trim()) { setConfirmImport(id, true); return; } // don't silently overwrite
    setMemo(id, sessionNoteText);
  };

  const completeM = useMutation({
    // Send the multi-authorization shape: each selected authorization with its
    // own memo. The server validates every id against the appointment's set.
    mutationFn: () => complete(payload.appointmentId, {
      authorizations: chosen.map((a) => ({
        authorizationId: a.id,
        ...(sel[a.id]?.memo?.trim() ? { memo: sel[a.id].memo.trim() } : {}),
      })),
    }),
    onSuccess: (r) => setResult(r),
  });

  return (
    <Modal open title={result ? 'Session completed' : 'Complete session'} onClose={result ? onCompleted : onClose}>
      {!result ? (
        <div className="rx-cm">
          <dl className="rx-cm__summary">
            <div><dt>Client</dt><dd>{childName}</dd></div>
            <div><dt>Start</dt><dd className="rx-cm__num">{clockTime(payload.startedAt)}</dd></div>
            <div><dt>End</dt><dd className="rx-cm__num">{clockTime(payload.endedAt)}</dd></div>
            <div><dt>Duration</dt><dd className="rx-cm__num"><strong>{payload.durationText || '—'}</strong></dd></div>
          </dl>

          <div>
            <div className="rx-cm__label">Authorizations for this session</div>
            {eligible.length === 0 ? (
              <div className="rx-row__meta">No authorizations are available on this appointment.</div>
            ) : (
              <div className="rx-cm__auths">
                {eligible.map((a) => {
                  const on = sel[a.id]?.selected;
                  return (
                    <div key={a.id} className={`rx-cm__auth${on ? ' is-selected' : ''}`}>
                      <label className="rx-cm__auth-check">
                        <input type="checkbox" checked={!!on} onChange={() => toggle(a.id)} />
                        <span>{a.label}</span>
                      </label>
                      {on && (
                        <div className="rx-cm__auth-body">
                          <div className="rx-cm__auth-head">
                            <span className="rx-cm__label">Memo for this authorization</span>
                            <Button variant="ghost" onClick={() => importInto(a.id)} disabled={!hasNote}>Import from Session Note</Button>
                          </div>
                          {sel[a.id]?.confirmImport && (
                            <div className="rx-alert rx-cm__confirm">
                              <span>Replace the current memo with your Session Note?</span>
                              <span style={{ display: 'inline-flex', gap: 6 }}>
                                <Button variant="ghost" onClick={() => setConfirmImport(a.id, false)}>Cancel</Button>
                                <Button onClick={() => setMemo(a.id, sessionNoteText)}>Replace</Button>
                              </span>
                            </div>
                          )}
                          <Field label="" hint="What was worked on under this authorization?">
                            <Textarea
                              value={sel[a.id]?.memo ?? ''}
                              onChange={(e) => setMemo(a.id, e.target?.value ?? e)}
                              placeholder="Document the work billed to this authorization…"
                              rows={3}
                            />
                          </Field>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {completeM.isError && (
            <div className="rx-cm__error" role="alert">
              {completeM.error?.response?.data?.error?.message || 'Could not complete the session. Please try again.'}
            </div>
          )}

          <div className="rx-cm__actions">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button icon={Icon.CheckCircle} onClick={() => completeM.mutate()} loading={completeM.isPending} disabled={chosen.length === 0}>
              Complete session
            </Button>
          </div>
        </div>
      ) : (
        <div className="rx-cm">
          <EmptyState icon={Icon.CheckCircle} title="Session completed" body="Your worked time has been recorded." />
          <dl className="rx-cm__summary">
            <div><dt>Worked time</dt><dd className="rx-cm__num"><strong>{workedText(result.timeRecord?.workedMinutes)}</strong></dd></div>
          </dl>
          <div className="rx-cm__actions">
            <Button icon={Icon.CheckCircle} onClick={onCompleted}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * ---------------------------------------------------------------------------
 * SHARED BCBA appointment board (spec §C, §8, §17–§21).
 *
 * The Session Panel and the BCBA Dashboard both render the BCBA's own
 * appointment cards with the SAME Start / Stop / Finish affordances, driven by
 * the SAME server-authoritative panel data (useBcbaActiveSession → getBcbaPanel)
 * and the SAME canonical start/stop/complete APIs. To avoid a second, drifting
 * copy of that UI (Part 32/33 — no duplicate session architecture), the card,
 * the section, the start/stop/complete wiring and the completion modal live
 * here once and are consumed by both surfaces.
 *
 * Server ownership holds: every card the panel returns is already scoped to the
 * authenticated BCBA (appointment.bcbaId === me) and each card's `canStart`
 * reflects the assignment gate. Starting a session posts only the appointmentId;
 * the server resolves the acting BCBA from the token and mutates ONLY that
 * BCBA-owned session — the Dashboard cannot start an RBT session or another
 * clinician's session. Nothing here creates a duplicate session, timer or time
 * record.
 * ---------------------------------------------------------------------------
 */

/**
 * Owns the Start / Stop / Complete mutations, the per-appointment start-error
 * map and the completion-modal state for the BCBA appointment board. A single
 * instance is shared by the active-session hero (page level) and the
 * appointment cards, so a session stopped from either surface flows through the
 * one completion modal — never two.
 */
export function useBcbaSessionActions() {
  const qc = useQueryClient();
  const [completing, setCompleting] = useState(null); // stop payload → completion modal
  const [startError, setStartError] = useState({});   // appointmentId → message

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['bcba', 'panel'] });
    qc.invalidateQueries({ queryKey: ['bcba', 'weekly-hours'] });
    qc.invalidateQueries({ queryKey: ['dashboard', 'bcba'] });
  };

  const startM = useMutation({
    mutationFn: (appointmentId) => startBcbaSession(appointmentId),
    onMutate: (appointmentId) => setStartError((e) => { const { [appointmentId]: _drop, ...rest } = e; return rest; }),
    onSuccess: refresh,
    onError: (err, appointmentId) => {
      const msg = err?.response?.data?.error?.message || 'Could not start the session. Please try again.';
      setStartError((e) => ({ ...e, [appointmentId]: msg }));
      refresh();
    },
  });

  const stopM = useMutation({
    mutationFn: (appointmentId) => stopBcbaSession(appointmentId),
    onSuccess: (payload) => { setCompleting(payload); refresh(); },
  });

  return { startM, stopM, startError, completing, setCompleting, refresh };
}

/**
 * SESSION QUEUE — the clinician's appointment list, shared by the BCBA Session
 * Panel, the BCBA Dashboard and the RBT Dashboard (one component, not a card
 * grid per page). Each row: when · client (and, for the BCBA, the assigned RBT)
 * · status · the server-authoritative Start / Stop / Finish action.
 *
 * Start is offered only when the server says the lifecycle allows it
 * (`card.canStart`) AND the shared 24-hour start-window rule is open at the
 * queue's clock; once the window closes the row shows "Expired" and why. A
 * stopped session can always be finished, so recorded time is never lost.
 *
 * `limit` shows the first N rows with a "Show all" control — used for past
 * appointments, which are informational (live sessions are never in that
 * group: groupSessionCards puts IN_PROGRESS / STOPPED in the current group).
 */
export function SessionQueue({
  title, cards, childNameFor, rbtNameFor = null, startError = {}, onStart, onStop,
  startingId = null, stoppingId = null, emptyHint = null, limit = null, order = 'asc', id,
}) {
  const tz = useOrgTimezone();
  const now = useStartWindowClock(cards, tz);
  const [expanded, setExpanded] = useState(false);
  if (!cards.length) {
    if (!emptyHint) return null;
    return (
      <section className="rx-sq rx-card" aria-labelledby={id}>
        <header className="rx-sq__head"><h2 className="rx-sq__title" id={id}>{title}</h2><span className="rx-sq__count">0</span></header>
        <p className="rx-sq__empty">{emptyHint}</p>
      </section>
    );
  }
  const ordered = order === 'desc' ? [...cards].reverse() : cards;
  const visible = limit && !expanded ? ordered.slice(0, limit) : ordered;
  return (
    <section className="rx-sq rx-card" aria-labelledby={id}>
      <header className="rx-sq__head">
        <h2 className="rx-sq__title" id={id}>{title}</h2>
        <span className="rx-sq__count">{cards.length}</span>
      </header>
      <ul className="rx-sq__list">
        {visible.map((card) => (
          <SessionQueueRow
            key={card.appointmentId}
            card={card}
            now={now}
            tz={tz}
            childName={childNameFor(card)}
            rbtName={rbtNameFor ? rbtNameFor(card) : null}
            error={startError[card.appointmentId]}
            onStart={() => onStart(card.appointmentId)}
            onStop={() => onStop(card.appointmentId)}
            starting={startingId === card.appointmentId}
            stopping={stoppingId === card.appointmentId}
          />
        ))}
      </ul>
      {limit && cards.length > limit && (
        <button type="button" className="rx-sq__more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? 'Show fewer' : `Show all ${cards.length}`}
        </button>
      )}
    </section>
  );
}

function SessionQueueRow({ card, now, tz, childName, rbtName, error, onStart, onStop, starting, stopping }) {
  const authCount = card.authorizationIds?.length || 0;
  const startable = isStartableNow(card, tz, now);
  const startLabel = startabilityLabel(card, tz, now);
  const expired = isExpiredAppointment(card, tz, now);
  const badge = expired && card.sessionStatus === 'SCHEDULED' ? <Badge tone="denied">Expired</Badge> : statusBadge(card.sessionStatus);
  const meta = [
    rbtName != null ? `RBT: ${rbtName}` : null,
    authCount ? `${authCount} authorization${authCount === 1 ? '' : 's'}` : 'No authorization on this appointment',
  ].filter(Boolean).join(' · ');
  return (
    <li className={`rx-sq__row${card.sessionStatus === 'IN_PROGRESS' ? ' is-live' : ''}`}>
      <div className="rx-sq__when">{occurrenceText(card, tz, now, { todayLabel: true })}</div>
      <div className="rx-sq__who">
        <Link className="rx-sq__name" to={`/clients/${card.clientId}`}>{childName}</Link>
        <div className="rx-sq__meta">{meta}</div>
      </div>
      <div className="rx-sq__status">{badge}</div>
      <div className="rx-sq__actions">
        {card.canStart && !startable && (
          <span className={`rx-sq__hint${expired ? ' is-expired' : ''}`} role="status">{startLabel || 'Not available today'}</span>
        )}
        {card.canStart && <Button size="sm" icon={Icon.Clock} onClick={onStart} loading={starting} disabled={!startable}>Start session</Button>}
        {card.sessionStatus === 'IN_PROGRESS' && <Button size="sm" variant="danger" onClick={onStop} loading={stopping}>Stop session</Button>}
        {card.sessionStatus === 'STOPPED' && <Button size="sm" onClick={onStop} loading={stopping}>Finish session</Button>}
      </div>
      {error && <div role="alert" className="rx-sq__error">{error}</div>}
    </li>
  );
}

/**
 * The BCBA's queue, wired to one useBcbaSessionActions() controller so every
 * row shares the one Start / Stop / Complete flow.
 */
export function AppointmentSection({ title, cards, names, actions, emptyHint, limit = null, order = 'asc', id }) {
  const { startM, stopM, startError } = actions;
  return (
    <SessionQueue
      id={id}
      title={title}
      cards={cards}
      limit={limit}
      order={order}
      emptyHint={emptyHint}
      childNameFor={(c) => c.childName || names.clientName(c.clientId)}
      // The appointment's RBT when it names one; otherwise the child's assigned
      // RBT from the server (care team). "None" only when no RBT is assigned.
      rbtNameFor={(c) => (c.rbtId ? names.rbtName(c.rbtId) : (c.assignedRbtName || 'None'))}
      startError={startError}
      onStart={(appointmentId) => startM.mutate(appointmentId)}
      onStop={(appointmentId) => stopM.mutate(appointmentId)}
      startingId={startM.isPending ? startM.variables : null}
      stoppingId={stopM.isPending ? stopM.variables : null}
    />
  );
}

/**
 * The stop→authorization→memo→complete modal wired to the BCBA complete API,
 * fed by a useBcbaSessionActions() result. Renders nothing until a session is
 * stopped. Resolves the child's display name from the card set (name, never id).
 */
export function BcbaCompletionModal({ actions, cards, names }) {
  const { completing, setCompleting, refresh } = actions;
  if (!completing) return null;
  const card = cards.find((c) => c.appointmentId === completing.appointmentId);
  return (
    <SessionCompletionModal
      payload={completing}
      childName={card?.childName || names.clientName(card?.clientId)}
      complete={completeBcbaSession}
      onClose={() => setCompleting(null)}
      onCompleted={() => { setCompleting(null); refresh(); }}
    />
  );
}
