import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listSessions } from '@/api/client';
import { PageHeader, Card, Badge, Icon, DataTable, Toolbar, Select, TextInput, Button, EmptyState } from '@/ui';
import { formatDate, formatDateTime, formatTime, sessionStatusText } from '@/lib/format';
import { civilDateString } from '@/lib/businessDate';
import { useAuthStore, useOrgTimezone } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { useBcbaNames } from '@/features/sessions/useBcbaSession.js';

/**
 * Sessions / Review queue — the canonical standalone session-review experience
 * (spec §F/§G). Backend-scoped: an RBT sees their own sessions, a BCBA their
 * caseload's, an operator the organization's. Every row is human-readable —
 * child and clinician NAMES (never ids), a human date/time (never an ISO
 * string), a status label and the actual worked duration. Today's sessions are
 * surfaced in their own section at the top. Opening a row routes to the ONE
 * canonical session detail (`/sessions/:id`) — no duplicate session route.
 */
const STATUS_OPTS = [
  { value: '', label: 'All statuses' },
  { value: 'DRAFT', label: 'Scheduled' }, { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'SUBMITTED', label: 'Submitted' }, { value: 'RETURNED', label: 'Returned' },
  { value: 'FROZEN', label: 'Completed' }, { value: 'CANCELLED', label: 'Cancelled' },
];

/**
 * Session times are INSTANTS; they are read on the organization's business
 * calendar (its timezone), never the browser's — a session recorded 10:15 AM in
 * the org's zone reads 10:15 AM for every viewer. Without an org timezone the
 * browser's is the only fallback.
 */
function isToday(v, timeZone) {
  if (!v) return false;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  if (timeZone) return civilDateString(d, timeZone) === civilDateString(new Date(), timeZone);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
/** Actual worked duration "1h 02m" from start/end, or "—" while running/unknown. */
function durationText(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '—';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
/**
 * Actual worked time for a row. Prefers the AUTHORITATIVE persisted
 * SessionTimeRecord.workedMinutes the API attaches; falls back to the persisted
 * start/end timestamps. Never a browser timer.
 */
function actualTime(r) {
  if (r.workedMinutes != null) {
    const m = Math.max(0, Math.round(Number(r.workedMinutes)));
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }
  return durationText(r.startedAt, r.endedAt);
}

/** A real, server-derived count — never an invented metric. */
function SummaryCard({ label, value, hint }) {
  return (
    <div className="rx-sl__stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {hint && <span className="rx-sl__stat-hint">{hint}</span>}
    </div>
  );
}

export function SessionsListRedesign() {
  const navigate = useNavigate();
  // The BCBA reviews sessions in their scope; the RBT sees their own sessions.
  // The server scopes the rows either way — this only changes the wording and
  // hides the clinician column the RBT does not need (it is always themselves).
  const roles = useAuthStore((s) => s.principal?.roles) ?? [];
  const isRbt = shellForRoles(roles) === 'rbt';
  const names = useBcbaNames();
  const timeZone = useOrgTimezone() || undefined;
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  // The query key is derived, so it must be MEMOISED. Rebuilding the params
  // object inline on every render is safe for react-query (it hashes keys by
  // value) but makes the dependency unstable for anything downstream; pinning it
  // keeps the key and every memo below stable across re-renders.
  const params = useMemo(() => (status ? { status } : {}), [status]);
  const query = useQuery({ queryKey: ['sessions', params], queryFn: () => listSessions(params) });

  const rows = query.data?.items ?? [];

  /**
   * THE LOADING GATE COVERS THE DIRECTORY LOOKUPS TOO.
   *
   * The Child and Clinician columns are resolved by useBcbaNames(), which issues
   * its own two requests. Those were NOT part of the table's loading state, so
   * on a cold visit the table painted immediately with every name showing its
   * neutral placeholder ("Child", "Assigned RBT") and then re-rendered once the
   * directories arrived. Revisiting served both directories from cache, so the
   * names were correct instantly — which is what made the queue look like it
   * only works the second time you open it.
   *
   * Gating the skeleton on `names.ready` as well means the first paint already
   * has real names. The directory requests still run in PARALLEL with the
   * sessions request (three independent useQuery hooks), so this costs no extra
   * round trip — it only stops the half-resolved intermediate state from being
   * shown.
   */
  const tableQuery = useMemo(
    () => ({ ...query, isLoading: query.isLoading || !names.ready }),
    [query, names.ready],
  );

  const childName = (r) => r.childName || names.clientName(r.clientId);
  const clinicianName = (r) => r.clinicianName || names.staffName(r.staffProfileId);

  // Every summary number is counted from the rows the server returned for the
  // current scope. Nothing here is invented or estimated.
  const summary = useMemo(() => {
    const count = (fn) => rows.filter(fn).length;
    return {
      total: rows.length,
      pending: count((r) => r.status === 'SUBMITTED'),
      inProgress: count((r) => r.status === 'IN_PROGRESS'),
      reviewed: count((r) => r.status === 'FROZEN'),
      returned: count((r) => r.status === 'RETURNED'),
    };
  }, [rows]);

  const todays = useMemo(() => rows.filter((r) => isToday(r.startedAt || r.startAt, timeZone)), [rows, timeZone]);

  // Search filters the rows already fetched — it does not issue another request.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${childName(r)} ${clinicianName(r)}`.toLowerCase().includes(q));
  }, [rows, search, names]);

  const filtered = Boolean(status || search.trim());

  const columns = [
    { key: 'child', header: 'Child',
      render: (r) => <span style={{ fontWeight: 600 }}>{childName(r)}</span> },
    { key: 'when', header: 'Session date', sortable: true, sortValue: (r) => r.startedAt || r.startAt || '',
      render: (r) => {
        const t = r.startedAt || r.startAt;
        if (!t) return '—';
        return (
          <span>
            {formatDate(t, timeZone)}
            <span className="rx-row__meta"> · {formatTime(t, timeZone)}</span>
          </span>
        );
      } },
    ...(isRbt ? [] : [{ key: 'clinician', header: 'Clinician',
      render: (r) => <span className="rx-row__meta">{clinicianName(r)}</span> }]),
    { key: 'duration', header: 'Worked time', render: (r) => actualTime(r) },
    { key: 'status', header: 'Status',
      render: (r) => <Badge tone={r.status === 'IN_PROGRESS' ? 'pending' : undefined} status={r.status}>{sessionStatusText(r)}{r.source === 'MANUAL' ? ' · Manual entry' : ''}</Badge> },
    { key: 'actions', header: '', align: 'right',
      render: (r) => (
        <button
          className="rx-btn rx-btn--ghost"
          aria-label={`${isRbt ? 'View' : 'Review'} session for ${childName(r)}`}
          onClick={(e) => { e.stopPropagation(); navigate(`/sessions/${r.id}`); }}
        >
          {isRbt ? 'View' : 'Review'}
        </button>
      ) },
  ];

  return (
    <div className="rx-sl">
      {isRbt ? (
        <PageHeader eyebrow="Session delivery" title="Sessions" subtitle="Your sessions — open one to see its time, authorization and memo." />
      ) : (
        <PageHeader eyebrow="Clinical supervision" title="Review Queue" subtitle="Sessions in your scope — open one to review the work, authorization and memo." />
      )}

      {/* Real counts from the sessions the server returned for this scope. */}
      <dl className="rx-sl__stats" aria-label="Sessions summary">
        <SummaryCard label={isRbt ? 'Submitted' : 'Pending review'} value={summary.pending} hint={isRbt ? 'Waiting for review' : 'Submitted, awaiting sign-off'} />
        <SummaryCard label="In progress" value={summary.inProgress} hint="Currently running" />
        <SummaryCard label="Returned" value={summary.returned} hint={isRbt ? 'Sent back to you' : 'Sent back to the technician'} />
        <SummaryCard label={isRbt ? 'Approved' : 'Reviewed'} value={summary.reviewed} hint={isRbt ? 'Approved and final' : 'Approved and final'} />
        <SummaryCard label="Total sessions" value={summary.total} hint="In the current view" />
      </dl>

      {todays.length > 0 && (
        <Card title="Today's sessions" hint={`${todays.length} today`} className="rx-todaysessions" style={{ marginBottom: 16 }}>
          <div className="rx-list">
            {todays.map((r) => (
              <button
                key={r.id}
                className="rx-row is-click"
                onClick={() => navigate(`/sessions/${r.id}`)}
                style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, cursor: 'pointer' }}
              >
                <div className="rx-row__main">
                  <div className="rx-row__title">{childName(r)}</div>
                  <div className="rx-row__meta">{formatDateTime(r.startedAt || r.startAt, timeZone)} · {actualTime(r)}</div>
                </div>
                <Badge tone={r.status === 'IN_PROGRESS' ? 'pending' : undefined} status={r.status}>{sessionStatusText(r)}{r.source === 'MANUAL' ? ' · Manual entry' : ''}</Badge>
              </button>
            ))}
          </div>
        </Card>
      )}

      <Toolbar>
        <Select value={status} onChange={setStatus} options={STATUS_OPTS} searchable={false} />
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isRbt ? 'Search client' : 'Search client or clinician'}
          aria-label={isRbt ? 'Search your sessions by client' : 'Search the review queue by client or clinician'}
        />
        {filtered && (
          <Button variant="ghost" onClick={() => { setStatus(''); setSearch(''); }}>Clear filters</Button>
        )}
      </Toolbar>

      <DataTable
        query={tableQuery}
        rows={tableQuery.isLoading ? undefined : visible}
        columns={columns}
        onRowClick={(r) => navigate(`/sessions/${r.id}`)}
        empty={(
          <EmptyState
            icon={Icon.CheckCircle}
            title={filtered ? 'No sessions match these filters' : isRbt ? 'No sessions yet' : "You're all caught up"}
            body={filtered ? 'Try clearing the filters to see everything in your scope.' : isRbt ? 'Your sessions appear here once you start them.' : 'No sessions are waiting for review.'}
          />
        )}
      />
    </div>
  );
}

export default SessionsListRedesign;
