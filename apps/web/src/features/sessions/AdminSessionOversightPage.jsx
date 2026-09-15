import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Icon, Button, Card, Select, ErrorState, ColumnChart } from '@/ui';
import { statusLabel, formatDate, formatTime, formatDuration, formatFullName, formatPersonName } from '@/lib/format';
import { civilDateString } from '@/lib/businessDate';
import { useOrgTimezone } from '@/auth/store';
import { getSessionInsights, listClients, listStaff, listSessions, listPlans, getPlan } from '@/api/client';
import { SessionRow } from './redesign/CompanySessionsPage.jsx';

/**
 * Company Admin SESSION INSIGHTS.
 *
 * Overview (one request): GET /v1/sessions/oversight/insights — the server
 * aggregates the caller's scoped sessions with their authoritative
 * SessionTimeRecords on the organization's business calendar: totals, status
 * counts, activity trend, per-clinician breakdown, recent sessions and the
 * per-child oversight rows. Filters (date range, client, clinician, status) are
 * applied by the server; nothing is estimated in the browser.
 *
 * Visual language is the Staff / Client / Sessions pages' own: the same page
 * header, summary cards, toolbar, list tables and session rows.
 *
 * Child detail keeps the existing child-first workflow (treatment plan, BCBA and
 * RBT sessions kept independent, RBT documentation). Read-only.
 */

const hm = (min) => (min == null ? '—' : formatDuration(min));
const hours = (min) => `${(Math.round(((Number(min) || 0) / 60) * 10) / 10).toLocaleString()} h`;
const dateOf = (v, tz) => (v ? formatDate(v, tz) : '—');
const clock = (v, tz) => (v ? formatTime(v, tz) : '—');
const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);
const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '·';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '12 months' },
  { value: 'all', label: 'All time' },
];
const STATUS_OPTS = [
  { value: '', label: 'All statuses' }, { value: 'DRAFT', label: 'Scheduled' }, { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'SUBMITTED', label: 'Submitted' }, { value: 'RETURNED', label: 'Returned' }, { value: 'FROZEN', label: 'Approved' },
  { value: 'AMENDED', label: 'Amended' }, { value: 'CANCELLED', label: 'Cancelled' },
];
const STATUS_TONE = { DRAFT: 'draft', IN_PROGRESS: 'pending', SUBMITTED: 'info', RETURNED: 'denied', FROZEN: 'approved', AMENDED: 'approved', CANCELLED: 'denied' };
const STATUS_ORDER = ['FROZEN', 'AMENDED', 'IN_PROGRESS', 'SUBMITTED', 'DRAFT', 'RETURNED', 'CANCELLED'];

const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
/** The org-calendar window for a preset: inclusive YYYY-MM-DD dates, or none for "All time". */
export function rangeFor(preset, timeZone, now = new Date()) {
  if (preset === 'all') return {};
  const today = civilDateString(now, timeZone || 'UTC');
  return { from: addDays(today, -(Number(preset) - 1)), to: today };
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function bucketLabel(key, unit) {
  const [y, m, d] = key.split('-').map(Number);
  if (unit === 'month') return { label: `${MONTHS[m - 1]} ${y}`, shortLabel: MONTHS[m - 1] };
  return { label: unit === 'week' ? `Week of ${formatDate(key)}` : formatDate(key), shortLabel: `${m}/${d}` };
}

function PageHead({ children }) {
  return (
    <header className="rx-st__head">
      <div className="rx-st__head-text">
        <h1 className="rx-st__title">Session Insights</h1>
        <p className="rx-st__subtitle">Session activity, worked time and documentation across your organization.</p>
      </div>
      {children}
    </header>
  );
}

export function AdminSessionOversightPage() {
  const tz = useOrgTimezone() || undefined;
  const [selected, setSelected] = useState(null); // { clientId, childName }
  const [preset, setPreset] = useState('30');
  const [clientId, setClientId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [status, setStatus] = useState('');
  const [term, setTerm] = useState('');

  const params = useMemo(() => ({
    ...rangeFor(preset, tz), ...(clientId ? { clientId } : {}), ...(staffId ? { staffProfileId: staffId } : {}), ...(status ? { status } : {}),
  }), [preset, tz, clientId, staffId, status]);
  const insightsQ = useQuery({ queryKey: ['insights', 'overview', params], queryFn: () => getSessionInsights(params) });
  // Filter menus only — never a gate on the page.
  const clients = useQuery({ queryKey: ['clients', 'opts', 100], queryFn: () => listClients({ limit: 100 }), staleTime: 60_000 });
  const staff = useQuery({ queryKey: ['staff', 'opts', 100], queryFn: () => listStaff({ limit: 100 }), staleTime: 60_000 });

  if (selected) {
    return (
      <div className="rx-si">
        <PageHead />
        <ChildDetail clientId={selected.clientId} childName={selected.childName} onBack={() => setSelected(null)} />
      </div>
    );
  }

  const loading = insightsQ.isLoading;
  const data = insightsQ.data;
  const totals = data?.totals ?? { sessions: 0, completed: 0, inProgress: 0, workedMinutes: 0, bcbaSessions: 0, rbtSessions: 0 };
  const filtered = Boolean(clientId || staffId || status || preset !== '30');
  const clearFilters = () => { setPreset('30'); setClientId(''); setStaffId(''); setStatus(''); };
  const children = (data?.children ?? []).filter((r) => !term.trim() || String(r.childName || '').toLowerCase().includes(term.trim().toLowerCase()));
  const statusRows = STATUS_ORDER.map((k) => ({ key: k, count: data?.statusCounts?.[k] ?? 0 })).filter((r) => r.count > 0);
  const points = (data?.trend?.points ?? []).map((p) => ({ key: p.key, value: p.sessions, ...bucketLabel(p.key, data.trend.unit) }));
  const clientOpts = [{ value: '', label: 'All clients' }, ...(clients.data?.items ?? []).map((c) => ({ value: c.id, label: formatFullName(c) }))];
  const staffOpts = [{ value: '', label: 'All clinicians' }, ...(staff.data?.items ?? []).map((s) => ({ value: s.id, label: formatFullName(s) }))];

  return (
    <div className="rx-si">
      <PageHead>
        <Link className="rx-ss__insights" to="/sessions"><Icon.Clipboard size={15} aria-hidden="true" /> All sessions</Link>
      </PageHead>

      <section className="rx-st__toolbar" aria-label="Filter insights">
        <div className="rx-st__filters rx-si__ranges" role="radiogroup" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r.value} type="button" role="radio" aria-checked={preset === r.value}
              className={`rx-st__filter${preset === r.value ? ' is-active' : ''}`} onClick={() => setPreset(r.value)}>{r.label}</button>
          ))}
        </div>
        <div className="rx-si__select"><Select value={clientId} onChange={setClientId} options={clientOpts} loading={clients.isLoading} placeholder="All clients" /></div>
        <div className="rx-si__select"><Select value={staffId} onChange={setStaffId} options={staffOpts} loading={staff.isLoading} placeholder="All clinicians" /></div>
        <div className="rx-si__select"><Select value={status} onChange={setStatus} options={STATUS_OPTS} searchable={false} placeholder="All statuses" /></div>
        {filtered && <Button variant="ghost" onClick={clearFilters}>Clear filters</Button>}
      </section>

      {insightsQ.isError ? (
        <Card pad={false}><ErrorState title="We couldn’t load Session Insights" body="Please try again in a moment." onRetry={() => insightsQ.refetch()} /></Card>
      ) : (
        <>
          {loading ? (
            <div className="rx-cl__summary" aria-busy="true" aria-label="Loading summary">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel rx-cl__stat-skel" />)}</div>
          ) : (
            <section className="rx-cl__summary" aria-label="Session summary">
              <Stat tone="violet" icon={Icon.Clipboard} label="Total sessions" value={totals.sessions} hint={`${totals.bcbaSessions} BCBA · ${totals.rbtSessions} RBT`} />
              <Stat tone="green" icon={Icon.CheckCircle} label="Completed" value={totals.completed} hint={`${pct(totals.completed, totals.sessions)}% of sessions`} />
              <Stat tone="amber" icon={Icon.Clock} label="In progress" value={totals.inProgress} hint="Currently clocked in" />
              <Stat tone="blue" icon={Icon.Chart} label="Worked hours" value={hours(totals.workedMinutes)}
                hint={totals.sessions ? `${hm(Math.round(totals.workedMinutes / totals.sessions))} per session` : 'No sessions in this period'} />
            </section>
          )}

          <div className="rx-si__grid">
            <Card title="Session activity" hint={data?.trend ? `Sessions per ${data.trend.unit}` : 'Sessions over time'}>
              {loading ? <div className="rx-skel" style={{ height: 206, borderRadius: 10 }} />
                : <ColumnChart points={points} height={180} ariaLabel="Sessions over time" formatValue={(v) => plural(v, 'session')} emptyText="No sessions in this period" />}
            </Card>
            <Card title="Status breakdown" hint={loading ? '' : plural(totals.sessions, 'session')}>
              {loading ? <div className="rx-skel" style={{ height: 206, borderRadius: 10 }} /> : statusRows.length === 0 ? (
                <p className="rx-si__muted">No sessions in this period.</p>
              ) : (
                <ul className="rx-si__status" aria-label="Sessions by status">
                  {statusRows.map((r) => (
                    <li key={r.key} className={`rx-si__status-row rx-si__status-row--${STATUS_TONE[r.key]}`}>
                      <span className="rx-si__status-label">{statusLabel(r.key)}</span>
                      <span className="rx-si__status-bar" aria-hidden="true"><span style={{ width: `${pct(r.count, totals.sessions)}%` }} /></span>
                      <span className="rx-si__status-value">{r.count}<small>{pct(r.count, totals.sessions)}%</small></span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card pad={false} className="rx-si__panel rx-si__panel--clinicians">
            <PanelHead title="Clinicians" hint="Sessions and worked time by clinician for the selected period" />
            {loading ? <ListSkeleton label="Loading clinicians" /> : (data?.clinicians ?? []).length === 0 ? (
              <EmptyBlock icon={Icon.Users} title="No clinician activity in this period" body="Clinicians appear here once they record sessions." />
            ) : (
              <>
                <div className="rx-st__listhead" aria-hidden="true">
                  <span>Clinician</span><span>Role</span><span className="rx-si__num">Sessions</span><span className="rx-si__num">Completed</span><span className="rx-si__num">In progress</span><span className="rx-si__num">Worked hours</span>
                </div>
                <ul className="rx-st__list" aria-label="Clinicians">
                  {data.clinicians.map((c) => {
                    const name = formatPersonName(c.name || '') || 'Clinician';
                    const role = c.role ? c.role.toLowerCase() : 'default';
                    return (
                      <li key={`${c.staffProfileId}:${c.role}`} className="rx-st__row rx-si__row--static">
                        <div className="rx-st__who">
                          <span className={`rx-st__avatar rx-st__avatar--${role}`} aria-hidden="true">{initials(name)}</span>
                          <div className="rx-st__who-text"><span className="rx-st__name">{name}</span></div>
                        </div>
                        <div className="rx-st__cell" data-label="Role">{c.role ? <span className={`rx-st__role rx-st__role--${role}`}>{c.role}</span> : <span className="rx-st__muted">—</span>}</div>
                        <div className="rx-st__cell rx-si__num" data-label="Sessions">{c.sessions}</div>
                        <div className="rx-st__cell rx-si__num" data-label="Completed">{c.completed}</div>
                        <div className="rx-st__cell rx-si__num" data-label="In progress">{c.inProgress}</div>
                        <div className="rx-st__cell rx-si__num" data-label="Worked hours">{hm(c.workedMinutes)}</div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Card>

          <section className="rx-si__section" aria-labelledby="si-recent">
            <div className="rx-si__section-head">
              <div><h2 id="si-recent" className="rx-card__title">Recent sessions</h2><p className="rx-card__hint">The latest sessions in this period — open one for its full detail</p></div>
              <Link to="/sessions" className="rx-st__action rx-st__action--primary">View all <Icon.Arrow size={14} aria-hidden="true" /></Link>
            </div>
            {loading ? (
              <ul className="rx-ss__list" aria-busy="true" aria-label="Loading recent sessions">{[0, 1, 2].map((i) => <li key={i} className="rx-skel rx-ss__skel" />)}</ul>
            ) : (data?.recent ?? []).length === 0 ? (
              <Card pad={false}><EmptyBlock icon={Icon.Clipboard} title="No sessions in this period" body={filtered ? 'Try a wider date range or clear the filters.' : 'Sessions appear here as soon as clinicians start or record them.'} /></Card>
            ) : (
              <ul className="rx-ss__list" aria-label="Recent sessions">
                {data.recent.map((r) => (
                  <SessionRow key={r.id} timeZone={tz}
                    row={{ id: r.id, childName: r.childName, clinicianName: r.clinicianName, role: r.role, startedAt: r.startedAt, actualStart: r.clockIn, actualEnd: r.clockOut, workedMinutes: r.workedMinutes, status: r.status, source: r.source }} />
                ))}
              </ul>
            )}
          </section>

          <Card pad={false} className="rx-si__panel rx-si__panel--children">
            <PanelHead title="Children" hint="Open a child for the treatment plan, BCBA and RBT sessions, and documentation">
              <label className="rx-st__search rx-si__search">
                <Icon.Search size={18} aria-hidden="true" />
                <span className="rx-st__sr">Search child</span>
                <input type="search" placeholder="Search child" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search child" maxLength={100} />
                {term && <button type="button" className="rx-st__clear" onClick={() => setTerm('')} aria-label="Clear search"><Icon.Close size={15} /></button>}
              </label>
            </PanelHead>
            {loading ? <ListSkeleton label="Loading children" /> : (data?.children ?? []).length === 0 ? (
              <EmptyBlock icon={Icon.Child} title="No children available" body="Children with recorded sessions in this period will appear here." />
            ) : children.length === 0 ? (
              <EmptyBlock icon={Icon.Search} title="No children match your search" body="Try a different name, or clear the search." action={<Button variant="ghost" onClick={() => setTerm('')}>Clear search</Button>} />
            ) : (
              <>
                <div className="rx-st__listhead" aria-hidden="true">
                  <span>Child</span><span>Care team</span><span className="rx-si__num">Sessions</span><span className="rx-si__num">Worked time</span><span>Last session</span><span className="rx-st__listhead-actions">Actions</span>
                </div>
                <ul className="rx-st__list" aria-label="Children">
                  {children.map((r) => {
                    const name = formatPersonName(r.childName || '') || 'Child';
                    const open = () => setSelected({ clientId: r.clientId, childName: r.childName });
                    return (
                      <li key={r.clientId} className="rx-st__row" onClick={open}>
                        <div className="rx-st__who">
                          <span className="rx-cl__avatar rx-cl__avatar--active" aria-hidden="true">{initials(name)}</span>
                          <div className="rx-st__who-text"><span className="rx-st__name">{name}</span></div>
                        </div>
                        <div className="rx-st__cell rx-cl__team" data-label="Care team">
                          <TeamMember role="BCBA" names={r.bcbaNames} />
                          <TeamMember role="RBT" names={r.rbtNames} />
                        </div>
                        <div className="rx-st__cell rx-si__num" data-label="Sessions">{r.sessionCount}</div>
                        <div className="rx-st__cell rx-si__num" data-label="Worked time">{hm(r.workedMinutes)}</div>
                        <div className="rx-st__cell" data-label="Last session">{dateOf(r.lastSessionAt, tz)}</div>
                        <div className="rx-st__actions" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="rx-st__action rx-st__action--primary" onClick={open} aria-label={`View insights for ${name}`}>View <Icon.Arrow size={14} /></button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <footer className="rx-st__foot"><span className="rx-st__count">Showing {plural(children.length, 'child', 'children')}</span></footer>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ tone, icon: IconCmp, label, value, hint }) {
  return (
    <div className={`rx-cl__stat rx-cl__stat--${tone}`}>
      <span className="rx-cl__stat-icon" aria-hidden="true"><IconCmp size={18} /></span>
      <span className="rx-cl__stat-body">
        <span className="rx-cl__stat-label">{label}</span>
        <span className="rx-cl__stat-value">{value}</span>
        {hint ? <span className="rx-cl__stat-hint">{hint}</span> : null}
      </span>
    </div>
  );
}

function PanelHead({ title, hint, children }) {
  return (
    <header className="rx-si__panel-head">
      <div><h2 className="rx-card__title">{title}</h2>{hint ? <p className="rx-card__hint">{hint}</p> : null}</div>
      {children}
    </header>
  );
}

function TeamMember({ role, names }) {
  const text = names && names.length ? names.join(', ') : null;
  return (
    <span className={`rx-cl__member${text ? '' : ' is-empty'}`}>
      <span className={`rx-cl__member-role rx-cl__member-role--${role.toLowerCase()}`}>{role}</span>
      <span className="rx-cl__member-name">{text ?? 'Not assigned'}</span>
    </span>
  );
}

function EmptyBlock({ icon: IconCmp, title, body, action }) {
  return (
    <div className="rx-st__empty">
      <span className="rx-st__empty-icon" aria-hidden="true"><IconCmp size={22} /></span>
      <div className="rx-st__empty-title">{title}</div>
      {body ? <p className="rx-st__empty-body">{body}</p> : null}
      {action}
    </div>
  );
}

function ListSkeleton({ label }) {
  return (
    <div className="rx-st__skeleton" aria-busy="true" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rx-st__skel-row">
          <div className="rx-skel rx-st__skel-avatar" />
          <div style={{ flex: 1 }}><div className="rx-skel" style={{ height: 12, width: '34%' }} /><div className="rx-skel" style={{ height: 10, width: '18%', marginTop: 8 }} /></div>
          <div className="rx-skel" style={{ height: 22, width: 64, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}

// ---- Child detail (existing child-first workflow) ---------------------------

const byNewest = (a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0);
const minutesFor = (rows) => rows.reduce((a, r) => a + (r.workedMinutes != null ? Math.max(0, Math.round(Number(r.workedMinutes))) : 0), 0);
// Scheduled window from THIS session's own appointment. A date-only appointment
// (timeSet:false) shows the calendar date, never a fabricated 12:00 AM.
const scheduleText = (r, tz) => {
  if (r.scheduledTimeSet === false) return r.scheduledStart ? `Date: ${dateOf(r.scheduledStart, tz)}` : 'Not scheduled';
  if (!r.scheduledStart) return 'Not scheduled';
  return r.scheduledEnd ? `${clock(r.scheduledStart, tz)} – ${clock(r.scheduledEnd, tz)}` : clock(r.scheduledStart, tz);
};
const workedText = (r) => (r.workedMinutes == null ? (String(r.status).toUpperCase() === 'IN_PROGRESS' ? 'In progress' : '—') : hm(r.workedMinutes));

function SessionTable({ title, rows, emptyText }) {
  const tz = useOrgTimezone() || undefined;
  const navigate = useNavigate();
  return (
    <Card pad={false} className="rx-si__panel rx-si__panel--child-sessions">
      <PanelHead title={title} hint={plural(rows.length, 'session')} />
      {rows.length === 0 ? <p className="rx-si__muted rx-si__pad">{emptyText}</p> : (
        <>
          <div className="rx-st__listhead" aria-hidden="true">
            <span>Clinician</span><span>Date</span><span>Scheduled</span><span>Clocked in</span><span>Clocked out</span><span className="rx-si__num">Actual worked</span><span>Status</span>
          </div>
          <ul className="rx-st__list" aria-label={title}>
            {rows.map((r) => (
              <li key={r.id} className="rx-st__row" onClick={() => navigate(`/sessions/${r.id}`)}>
                <div className="rx-st__who"><Link to={`/sessions/${r.id}`} className="rx-st__name" onClick={(e) => e.stopPropagation()}>{r.clinicianName || 'Clinician'}</Link></div>
                <div className="rx-st__cell" data-label="Date">{dateOf(r.startedAt || r.scheduledStart, tz)}</div>
                <div className="rx-st__cell" data-label="Scheduled">{scheduleText(r, tz)}</div>
                <div className="rx-st__cell" data-label="Clocked in">{clock(r.actualStart ?? r.startedAt, tz)}</div>
                <div className="rx-st__cell" data-label="Clocked out">{clock(r.actualEnd ?? r.endedAt, tz)}</div>
                <div className="rx-st__cell rx-si__num" data-label="Actual worked">{workedText(r)}</div>
                <div className="rx-st__cell" data-label="Status"><Badge tone={STATUS_TONE[String(r.status || '').toUpperCase()] ?? 'draft'}>{statusLabel(r.status)}</Badge></div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// Treatment plan review (read-only): the child's active BCBA plan with its goals → programs → targets.
function TreatmentPlanCard({ clientId }) {
  const plansQ = useQuery({ queryKey: ['insights', 'plans', clientId], queryFn: () => listPlans({ clientId }) });
  const planItems = plansQ.data?.items ?? plansQ.data ?? [];
  const summary = planItems.find((p) => String(p.status).toUpperCase() === 'ACTIVE') || planItems[0] || null;
  const detailQ = useQuery({ queryKey: ['insights', 'plan', summary?.id], queryFn: () => getPlan(summary.id), enabled: Boolean(summary?.id) });
  const plan = detailQ.data?.plan ?? summary ?? null;
  const goals = detailQ.data?.goals ?? [];
  const programCount = goals.reduce((a, g) => a + (g.programs?.length ?? 0), 0);
  const targetCount = goals.reduce((a, g) => a + (g.programs ?? []).reduce((b, p) => b + (p.targets?.length ?? 0), 0), 0);

  return (
    <Card title="Treatment plan" hint="The child’s active BCBA plan (read-only)">
      {plansQ.isLoading ? <p className="rx-si__muted">Loading…</p> : !summary ? <p className="rx-si__muted">No active treatment plan found.</p> : (
        <div className="rx-si__plan">
          <div className="rx-si__plan-title"><strong>{plan.title || plan.name || 'Treatment plan'}</strong><Badge status={String(plan.status || '').toUpperCase()}>{statusLabel(plan.status)}</Badge></div>
          <p className="rx-si__muted">
            {[plan.responsibleBcbaName ? `BCBA: ${plan.responsibleBcbaName}` : null, plan.updatedAt ? `Last updated ${dateOf(plan.updatedAt)}` : null,
              goals.length ? `${plural(goals.length, 'goal')} · ${plural(programCount, 'program')} · ${plural(targetCount, 'target')}` : null].filter(Boolean).join(' · ')}
          </p>
          {!detailQ.isError && goals.length > 0 && (
            <ul className="rx-si__goals">
              {goals.map((g) => (
                <li key={g.id}>
                  <strong>{g.title || g.name || 'Goal'}</strong>
                  {(g.programs ?? []).map((p) => (
                    <div key={p.id} className="rx-si__program">
                      <span>{p.title || p.name || 'Program'}</span>
                      {(p.targets ?? []).length > 0 && <ul>{p.targets.map((t) => <li key={t.id}>{t.title || t.name || t.label || 'Target'}</li>)}</ul>}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function ChildDetail({ clientId, childName, onBack }) {
  const tz = useOrgTimezone() || undefined;
  const sessionsQ = useQuery({ queryKey: ['insights', 'sessions', clientId], queryFn: () => listSessions({ clientId, limit: 100 }) });
  const rows = sessionsQ.data?.items ?? [];
  const bcbaRows = useMemo(() => rows.filter((r) => r.role === 'BCBA').sort(byNewest), [rows]);
  const rbtRows = useMemo(() => rows.filter((r) => r.role === 'RBT').sort(byNewest), [rows]);
  const bcbaMin = minutesFor(bcbaRows);
  const rbtMin = minutesFor(rbtRows);
  const documented = rbtRows.filter((r) => r.documentation && (r.documentation.what || r.documentation.how || r.documentation.childResponse));
  const name = formatPersonName(childName || '') || 'Child';

  return (
    <>
      <div className="rx-si__child-head">
        <button type="button" className="rx-sp__back" onClick={onBack}><Icon.Return size={15} /> All children</button>
        <div className="rx-st__who">
          <span className="rx-cl__avatar rx-cl__avatar--active" aria-hidden="true">{initials(name)}</span>
          <div className="rx-st__who-text"><h2 className="rx-si__child-name">{name}</h2><div className="rx-st__sub">Child session insights</div></div>
        </div>
      </div>

      {sessionsQ.isLoading ? (
        <div className="rx-cl__summary rx-si__summary--3" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="rx-skel rx-cl__stat-skel" />)}</div>
      ) : (
        <section className="rx-cl__summary rx-si__summary--3" aria-label="Worked time">
          <Stat tone="violet" icon={Icon.Clock} label="BCBA worked time" value={hm(bcbaMin)} hint={plural(bcbaRows.length, 'session')} />
          <Stat tone="blue" icon={Icon.Clock} label="RBT worked time" value={hm(rbtMin)} hint={plural(rbtRows.length, 'session')} />
          <Stat tone="green" icon={Icon.Chart} label="Total worked time" value={hm(bcbaMin + rbtMin)} hint={plural(rows.length, 'session')} />
        </section>
      )}

      <TreatmentPlanCard clientId={clientId} />

      {sessionsQ.isError ? (
        <Card pad={false}><ErrorState title="We couldn’t load these sessions" body="Please try again in a moment." onRetry={() => sessionsQ.refetch()} /></Card>
      ) : sessionsQ.isLoading ? (
        <Card pad={false}><ListSkeleton label="Loading sessions" /></Card>
      ) : rows.length === 0 ? (
        <Card pad={false}><EmptyBlock icon={Icon.Clock} title="No sessions recorded for this child yet." body="Scheduled times come from the appointment; actual times from the session record." /></Card>
      ) : (
        <>
          <SessionTable title="BCBA Sessions" rows={bcbaRows} emptyText="No BCBA sessions recorded." />
          <SessionTable title="RBT Sessions" rows={rbtRows} emptyText="No RBT sessions recorded." />
        </>
      )}

      <Card title="RBT session documentation" hint="What the RBT worked on, how it was implemented, and how the child responded">
        {sessionsQ.isLoading ? <p className="rx-si__muted">Loading…</p> : documented.length === 0 ? (
          <p className="rx-si__muted">No session documentation recorded yet.</p>
        ) : documented.map((r) => (
          <article key={r.id} className="rx-si__doc">
            <div className="rx-si__doc-head"><strong>{r.clinicianName || 'RBT'} — {dateOf(r.startedAt, tz)}</strong><span>{workedText(r)} worked</span></div>
            <dl>
              <div><dt>What did you work on?</dt><dd>{r.documentation.what?.trim() || 'Not documented.'}</dd></div>
              <div><dt>How did you implement it?</dt><dd>{r.documentation.how?.trim() || 'Not documented.'}</dd></div>
              <div><dt>Child response</dt><dd>{r.documentation.childResponse?.trim() || 'Not documented.'}</dd></div>
            </dl>
          </article>
        ))}
      </Card>
    </>
  );
}

export default AdminSessionOversightPage;
