import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { useAuthStore } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import {
  addProgram, addTarget,
  archiveGoal, archiveProgram, archiveTarget, updateTarget, updateGoal,
  archivePlan, deletePlan, getPlan, getClient,
} from '@/api/client';
import { Button, Badge, Icon, Confirm } from '@/ui';
import { formatDate, formatDateTime } from '@/lib/format';
import { useBcbaNames } from '@/features/sessions/useBcbaSession.js';


/** Plain enum → sentence-case label ("IN_PROGRESS" → "In progress"). Plan and
 *  goal enums are not session statuses, so the session label map is not used. */
function humanize(value) {
  if (!value) return '';
  const s = String(value).replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const MEASUREMENT_TYPES = ['PERCENT_CORRECT', 'FREQUENCY', 'DURATION', 'RATE', 'TRIALS_TO_CRITERION', 'INTERVAL'];
const STATUS_TONE = { ACTIVE: 'approved', DRAFT: 'draft', ARCHIVED: 'draft' };
const GOAL_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'MET', 'DISCONTINUED'];

/**
 * Treatment plan detail — built from the Session Detail layout (back link,
 * hero with identity/status/actions, key-fact tiles, section cards) so it
 * matches Client Detail, Staff Profile and Session Detail. Goals own their
 * program → target tree.
 *
 * Goals are maintained through the plan editor; this page deliberately offers
 * no goal-creation control. Existing goal management (status, progress,
 * archive), programs, targets and weekly focus are preserved and gated on the
 * same permissions.
 *
 * Real data only: the child name, responsible-BCBA name and "last updated"
 * value come from the persisted plan the API returns (names resolved
 * server-side, tenant-scoped) — never a raw id or a generic placeholder. An
 * ARCHIVED plan is read-only (the server rejects writes with 409). Delete is a
 * server-authorized, real removal. Animations respect prefers-reduced-motion.
 */
export function PlanDetailPage() {
  const { planId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { permissions } = usePermissions();
  const canUpdate = permissions.includes('plans.update');
  const canArchive = permissions.includes('plans.archive');
  const isRbt = shellForRoles(useAuthStore((s) => s.principal?.roles) ?? []) === 'rbt';
  const reduce = useReducedMotion();

  const [confirmDelete, setConfirmDelete] = useState(false);

  const query = useQuery({ queryKey: ['plan', planId], queryFn: () => getPlan(planId) });
  const plan = query.data?.plan;
  const names = useBcbaNames();

  // Child name for the hero + details. The server resolves the real name on the
  // plan (plan.childName); getClient is a resilient secondary source. Guarded so
  // a focused test that mocks only the plan API simply falls back.
  const child = useQuery({
    queryKey: ['client', plan?.clientId],
    queryFn: () => getClient(plan.clientId),
    enabled: !!plan?.clientId && typeof getClient === 'function',
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['plan', planId] });
  const archiveMutation = useMutation({
    mutationFn: () => archivePlan(planId),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['plans'] }); await invalidate(); },
  });
  // Real delete: DELETE /v1/plans/:id (server-authorized, soft-delete cascade),
  // then invalidate the plans caches and return to the roster.
  const deleteMutation = useMutation({
    mutationFn: () => deletePlan(planId),
    onSuccess: async () => {
      setConfirmDelete(false);
      await queryClient.invalidateQueries({ queryKey: ['plans'] });
      queryClient.removeQueries({ queryKey: ['plan', planId] });
      navigate('/plans', { replace: true });
    },
  });

  const childFromClient = child.data
    ? (child.data.displayName || [child.data.firstName, child.data.lastName].filter(Boolean).join(' ').trim())
    : null;
  const childName = plan?.childName || childFromClient || null;

  // Responsible BCBA: prefer the server-resolved real name; the names hook's
  // generic fallbacks are treated as "no real name".
  const staffResolved = plan?.responsibleBcbaStaffId ? names.staffName(plan.responsibleBcbaStaffId) : null;
  const bcbaName = plan?.responsibleBcbaName
    || (staffResolved && !['Staff member', '—'].includes(staffResolved) ? staffResolved : null);

  const lastUpdated = plan?.updatedAt ? formatDateTime(plan.updatedAt) : null;

  const backLink = <Link to="/plans" className="rx-sp__back"><Icon.Return size={15} /> {isRbt ? 'Back to Programs' : 'Back to Treatment Plans'}</Link>;

  if (query.isLoading) {
    return (
      <div className="rx-sd rx-tpd" aria-busy="true" aria-label="Loading treatment plan">
        {backLink}
        <div className="rx-skel" style={{ height: 118, borderRadius: 20 }} />
        <div className="rx-sd__facts">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel" style={{ height: 68, borderRadius: 14 }} />)}</div>
        <div className="rx-skel" style={{ height: 280, borderRadius: 18 }} />
      </div>
    );
  }
  if (query.isError || !plan) {
    const code = query.error?.response?.status;
    const notFound = !query.isError || code === 404 || code === 403;
    return (
      <div className="rx-sd rx-tpd">
        {backLink}
        <div className="rx-sd__state" role="alert">
          <span className="rx-sd__state-icon" aria-hidden="true"><Icon.Clipboard size={22} /></span>
          <h1 className="rx-sd__state-title">{notFound ? 'Treatment plan not found' : 'We couldn’t load this treatment plan'}</h1>
          <p className="rx-sd__muted">{notFound ? 'This treatment plan doesn’t exist or isn’t available to you.' : 'Check your connection and try again.'}</p>
          {notFound ? <Link className="rx-btn rx-btn--primary" to="/plans">Back to Treatment Plans</Link> : <Button onClick={() => query.refetch()}>Try again</Button>}
        </div>
      </div>
    );
  }

  const goals = query.data.goals ?? [];
  const editable = canUpdate && plan.status !== 'ARCHIVED';
  const activeGoals = goals.filter((g) => g.status !== 'ARCHIVED').length;
  const tone = STATUS_TONE[plan.status] ?? 'info';
  const initials = (childName || plan.title || 'TP').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  return (
    <>
      <div className="rx-sd rx-tpd">
        {backLink}

        {/* HERO — same structure as Session Detail: identity, status, actions. */}
        <header className={`rx-sd__hero rx-sd__hero--${tone}`}>
          <div className="rx-sd__hero-main">
            <span className="rx-sd__avatar" aria-hidden="true">{initials}</span>
            <div className="rx-sd__hero-text">
              <div className="rx-sd__eyebrow-row">
                <span className="rx-sd__eyebrow">Treatment Plan</span>
                <Badge status={plan.status}>{humanize(plan.status)}</Badge>
              </div>
              <h1 className="rx-sd__title">{plan.title || 'Treatment Plan'}</h1>
              {childName && <p className="rx-sd__when"><Icon.User size={14} aria-hidden="true" />{childName}</p>}
            </div>
          </div>
          {(editable || canArchive) && (
            <div className="rx-tpd__actions">
              {editable && <Link className="rx-btn rx-btn--primary" to={`/plans/${planId}/edit`}><Icon.Cog size={16} />Edit plan</Link>}
              {canArchive && plan.status !== 'ARCHIVED' && (
                <Button variant="ghost" icon={Icon.Return} onClick={() => archiveMutation.mutate()} loading={archiveMutation.isPending}>Archive</Button>
              )}
              {canArchive && (
                <Button variant="ghost" className="rx-sd__danger" icon={Icon.Trash} onClick={() => setConfirmDelete(true)}>Delete</Button>
              )}
            </div>
          )}
        </header>

        {!canUpdate && (
          <div className="rx-tpd__readonly" role="note">
            <Icon.Shield size={16} aria-hidden="true" />
            <span>View only. This treatment plan is maintained by the client’s BCBA.</span>
          </div>
        )}

        {/* KEY FACTS — real persisted fields only. Dates go through formatDate
            (MM/DD/YYYY, calendar parts read directly so a date-only value
            cannot shift by timezone). */}
        <dl className="rx-sd__facts">
          <Fact icon={Icon.User} tone="blue" label="Client"
            value={childName ? <Link to={`/clients/${plan.clientId}`}>{childName}</Link> : 'Not recorded'} />
          <Fact icon={Icon.Shield} tone="teal" label="Responsible BCBA" value={bcbaName || 'Not assigned'} />
          <Fact icon={Icon.Calendar} tone="amber" label="Review date" value={plan.reviewDate ? formatDate(plan.reviewDate) : 'Not scheduled'} />
          <Fact icon={Icon.Clock} label="Last updated" value={lastUpdated || 'Not recorded'} />
        </dl>

        <div className="rx-tpd__layout">
          <section className="rx-sd__card" aria-labelledby="tpd-details">
            <div className="rx-sd__card-head"><h2 id="tpd-details" className="rx-sd__card-title"><Icon.Clipboard size={16} aria-hidden="true" />Plan details</h2></div>
            <dl className="rx-sd__rows">
              <div className="rx-sd__row"><dt>Status</dt><dd>{humanize(plan.status)}</dd></div>
              <div className="rx-sd__row"><dt>Effective date</dt><dd>{plan.effectiveDate ? formatDate(plan.effectiveDate) : 'Not set'}</dd></div>
              <div className="rx-sd__row"><dt>Review date</dt><dd>{plan.reviewDate ? formatDate(plan.reviewDate) : 'Not scheduled'}</dd></div>
              <div className="rx-sd__row"><dt>Goals</dt><dd>{activeGoals} active{goals.length !== activeGoals ? ` of ${goals.length}` : ''}</dd></div>
            </dl>
            {plan.notes && (
              <div className="rx-sd__doc">
                <span className="rx-sd__doc-label">Plan notes</span>
                <p className="rx-sd__text">{plan.notes}</p>
              </div>
            )}
          </section>

          {/* GOALS (each goal owns its program -> target tree) */}
          <GoalsSection planId={planId} goals={goals} activeCount={activeGoals} editable={editable} onChange={invalidate} reduce={reduce} />
        </div>
      </div>

      <Confirm
        open={confirmDelete}
        tone="danger"
        title="Delete treatment plan?"
        message="Are you sure you want to delete this treatment plan? This action cannot be undone."
        confirmLabel="Delete"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => { if (!deleteMutation.isPending) setConfirmDelete(false); }}
      />
    </>
  );

  // ------------------------------------------------------------------ Goals
  function GoalsSection({ planId: pid, goals: goalList, activeCount, editable: canEdit, onChange, reduce: rm }) {
    return (
      <section className="rx-sd__card rx-tpd__goals" aria-labelledby="tpd-goals">
        <div className="rx-sd__card-head">
          <h2 id="tpd-goals" className="rx-sd__card-title"><Icon.CheckCircle size={16} aria-hidden="true" />Goals</h2>
          {goalList.length > 0 && <p className="rx-sd__card-hint">{activeCount} active of {goalList.length}</p>}
        </div>

        {goalList.length === 0 ? (
          <div className="rx-st__empty rx-tpd__empty">
            <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Clipboard size={22} /></span>
            <div className="rx-st__empty-title">No goals yet</div>
            <p className="rx-st__empty-body">Goals recorded for this treatment plan will appear here.</p>
          </div>
        ) : (
          <div className="rx-tpd__goal-list">
            {goalList.map((goal) => (
              <GoalCard key={goal.id} planId={pid} goal={goal} editable={canEdit} onChange={onChange} reduce={rm} />
            ))}
          </div>
        )}
      </section>
    );
  }

  function GoalCard({ planId: pid, goal, editable: canEdit, onChange, reduce: rm }) {
    const archiveMut = useMutation({ mutationFn: () => archiveGoal(pid, goal.id), onSuccess: onChange });
    const [show, setShow] = useState(false);
    const [name, setName] = useState('');
    const addProg = useMutation({ mutationFn: () => addProgram(pid, goal.id, { name: name.trim() }), onSuccess: async () => { setName(''); setShow(false); await onChange(); } });
    const statusMut = useMutation({ mutationFn: (patch) => updateGoal(pid, goal.id, patch, goal.version), onSuccess: onChange });
    const canEditGoal = canEdit && goal.status !== 'ARCHIVED';

    return (
      <article className="rx-goalcard">
        <div className="rx-goalcard__head">
          <div>
            <div className="rx-goalcard__title">{goal.description}</div>
            <div className="rx-goalcard__meta">{[goal.term ? humanize(goal.term) : null, goal.priority != null ? `Priority ${goal.priority}` : null].filter(Boolean).join(' · ')}</div>
          </div>
          <Badge status={goal.status}>{humanize(goal.status)}</Badge>
        </div>

        <ProgressBar value={goal.progress ?? 0} reduce={rm} />

        {canEditGoal && (
          <div className="rx-goalcard__controls">
            <label className="rx-inline-field">
              <span className="sr-only">Goal status</span>
              <select className="rx-tp-input" aria-label="Goal status" value={goal.status} disabled={statusMut.isPending}
                onChange={(e) => statusMut.mutate({ status: e.target.value })}>
                {GOAL_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </select>
            </label>
            <label className="rx-inline-field">
              <span className="sr-only">Goal progress</span>
              <input className="rx-tp-input" type="number" min="0" max="100" aria-label="Goal progress" defaultValue={goal.progress} disabled={statusMut.isPending}
                onBlur={(e) => { const v = Math.max(0, Math.min(100, Number(e.target.value))); if (v !== goal.progress) statusMut.mutate({ progress: v }); }} />
            </label>
            <span className="rx-muted">% complete</span>
            <button type="button" className="rx-linklike" onClick={() => archiveMut.mutate()}>Archive goal</button>
          </div>
        )}

        {canEditGoal && (
          <div className="rx-goalcard__progrow">
            <Button variant="ghost" icon={Icon.Plus} onClick={() => setShow((v) => !v)}>{show ? 'Close' : 'Add program'}</Button>
            {show && (
              <form onSubmit={(e) => { e.preventDefault(); addProg.mutate(); }} className="rx-inlineform">
                <input className="rx-tp-input" placeholder="Program name" value={name} onChange={(e) => setName(e.target.value)} required />
                <Button icon={Icon.Check} loading={addProg.isPending}>Add</Button>
              </form>
            )}
          </div>
        )}

        {(goal.programs ?? []).map((program) => (
          <ProgramRow key={program.id} planId={pid} program={program} editable={canEdit && goal.status !== 'ARCHIVED'} onChange={onChange} reduce={rm} />
        ))}
      </article>
    );
  }

  function ProgramRow({ planId: pid, program, editable: canEdit, onChange, reduce: rm }) {
    const archiveMut = useMutation({ mutationFn: () => archiveProgram(pid, program.id), onSuccess: onChange });
    const [show, setShow] = useState(false);
    const [form, setForm] = useState({ label: '', measurementType: 'PERCENT_CORRECT' });
    const addTgt = useMutation({ mutationFn: () => addTarget(pid, program.id, { label: form.label.trim(), measurementType: form.measurementType }), onSuccess: async () => { setForm({ label: '', measurementType: 'PERCENT_CORRECT' }); setShow(false); await onChange(); } });
    const active = canEdit && !program.archivedAt;

    return (
      <div className="rx-progblock" id={`program-${program.id}`}>
        <div className="rx-progblock__head">
          <span className="rx-progblock__name">{program.name}{program.archivedAt ? ' (Archived)' : ''}</span>
          {active && <button type="button" className="rx-linklike" onClick={() => archiveMut.mutate()}>Archive</button>}
        </div>
        {active && (
          <div className="rx-progblock__row">
            <Button variant="ghost" icon={Icon.Plus} onClick={() => setShow((v) => !v)}>{show ? 'Close' : 'Add target'}</Button>
            {show && (
              <form onSubmit={(e) => { e.preventDefault(); addTgt.mutate(); }} className="rx-inlineform">
                <input className="rx-tp-input" placeholder="Target label" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} required />
                <select className="rx-tp-input" value={form.measurementType} onChange={(e) => setForm((f) => ({ ...f, measurementType: e.target.value }))} aria-label="Measurement type">
                  {MEASUREMENT_TYPES.map((m) => <option key={m} value={m}>{humanize(m)}</option>)}
                </select>
                <Button icon={Icon.Check} loading={addTgt.isPending}>Add</Button>
              </form>
            )}
          </div>
        )}
        {(program.targets ?? []).map((target) => (
          <TargetRow key={target.id} planId={pid} programId={program.id} target={target}
            editable={canEdit && program.archivedAt == null} active={active} onChange={onChange} reduce={rm} />
        ))}
      </div>
    );
  }

  function TargetRow({ planId: pid, programId, target, editable: canEdit, active, onChange }) {
    const [instr, setInstr] = useState(target.weeklyInstructions ?? '');
    const [editingInstr, setEditingInstr] = useState(false);
    const toggle = useMutation({ mutationFn: () => updateTarget(pid, programId, target.id, { weeklyFocus: !target.weeklyFocus }, target.version), onSuccess: onChange });
    const saveInstr = useMutation({ mutationFn: () => updateTarget(pid, programId, target.id, { weeklyInstructions: instr.trim() || null }, target.version), onSuccess: async () => { setEditingInstr(false); await onChange(); } });

    return (
      <div className="rx-targetrow">
        <div className="rx-targetrow__main">
          <span>
            {target.label} <span className="rx-muted">({[humanize(target.measurementType), humanize(target.status), `${target.currentProgress ?? 0}%`].join(' · ')})</span>
            {target.weeklyFocus && <span className="rx-wkbadge">This week</span>}
          </span>
          <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
            {canEdit && (
              <button type="button" className="rx-linklike" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
                {target.weeklyFocus ? 'Remove from week' : 'Add to this week'}
              </button>
            )}
            {active && target.status !== 'INACTIVE' && canEdit && (
              <button type="button" className="rx-linklike" onClick={() => archiveTarget(pid, programId, target.id).then(onChange)}>Archive</button>
            )}
          </span>
        </div>
        {target.weeklyFocus && (
          <div className="rx-wkinstr">
            {canEdit && editingInstr ? (
              <span style={{ display: 'inline-flex', gap: 8, width: '100%' }}>
                <input className="rx-tp-input" value={instr} placeholder="This week's instructions for the RBT…" onChange={(e) => setInstr(e.target.value)} />
                <button type="button" className="rx-linklike" disabled={saveInstr.isPending} onClick={() => saveInstr.mutate()}>Save</button>
              </span>
            ) : (
              <span className="rx-muted">
                {target.weeklyInstructions ? `Instructions: ${target.weeklyInstructions}` : 'No weekly instructions yet.'}
                {canEdit && <button type="button" className="rx-linklike" style={{ marginLeft: 8 }} onClick={() => { setInstr(target.weeklyInstructions ?? ''); setEditingInstr(true); }}>Edit</button>}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
}

// --- small presentational helpers -----------------------------------------

function Fact({ icon: IconCmp, tone = 'violet', label, value }) {
  return (
    <div className={`rx-sd__fact rx-sd__fact--${tone}`}>
      <span className="rx-sd__fact-icon" aria-hidden="true"><IconCmp size={16} /></span>
      <div><dt>{label}</dt><dd>{value}</dd></div>
    </div>
  );
}

function ProgressBar({ value, reduce }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="rx-progressbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <motion.div
        className="rx-progressbar__fill"
        initial={reduce ? false : { width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: reduce ? 0 : 0.6, ease: 'easeOut' }}
      />
    </div>
  );
}

export default PlanDetailPage;
