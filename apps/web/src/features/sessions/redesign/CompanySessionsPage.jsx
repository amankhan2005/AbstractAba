import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSession, listClients, listSessions, listStaff } from '@/api/client';
import { useOrgTimezone } from '@/auth/store';
import { Badge, Button, Icon, Select } from '@/ui';
import { formatDate, formatFullName, formatPersonName, formatTime, sessionStatusText } from '@/lib/format';
import { civilDateString } from '@/lib/businessDate';

/**
 * COMPANY ADMIN · SESSIONS — every session delivered across the organization.
 *
 * Data: the existing GET /v1/sessions (tenant + data scope enforced server-side),
 * 50 rows per page with its cursor ("Load more"). Each row already carries the
 * child and clinician names, the clinician's role, the scheduled window and the
 * AUTHORITATIVE SessionTimeRecord (clock-in, clock-out, worked minutes), so the
 * page issues ONE list request — no per-row detail requests and no directory
 * lookups gating the first paint. Client / Clinician / Status filters are sent to
 * the server; the client and staff lists only populate those filter menus.
 *
 * Times are read on the organization's business calendar (its timezone).
 * BCBA and RBT keep their own Sessions / Review queue page (SessionsListRedesign).
 */
export const SESSION_PAGE_SIZE = 50;
export const SESSION_DETAIL_STALE_MS = 15_000;

const STATUS_OPTS = [
  { value: '', label: 'All statuses' },
  { value: 'DRAFT', label: 'Scheduled' }, { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'SUBMITTED', label: 'Submitted' }, { value: 'RETURNED', label: 'Returned' }, { value: 'FROZEN', label: 'Approved / completed' },
  { value: 'AMENDED', label: 'Amended' }, { value: 'CANCELLED', label: 'Cancelled' },
];
const STATUS_TONE = { DRAFT: 'draft', IN_PROGRESS: 'pending', SUBMITTED: 'info', RETURNED: 'denied', FROZEN: 'approved', AMENDED: 'approved', CANCELLED: 'denied' };
const COMPLETED = new Set(['FROZEN', 'AMENDED']);

/** Whole minutes → "1h 05m" / "45m". Authoritative persisted minutes only. */
export function workedLabel(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return null;
  const m = Math.max(0, Math.round(Number(minutes)));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}
const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '·';
/** The instant a session is dated by: its actual start, else the recorded start, else its scheduled start. */
const sessionInstant = (r) => r.actualStart || r.startedAt || r.scheduledStart || null;

export function CompanySessionsPage() {
  const qc = useQueryClient();
  const timeZone = useOrgTimezone() || undefined;
  const [status, setStatus] = useState('');
  const [clientId, setClientId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [search, setSearch] = useState('');

  const filters = useMemo(() => ({
    ...(status ? { status } : {}), ...(clientId ? { clientId } : {}), ...(staffId ? { staffProfileId: staffId } : {}),
  }), [status, clientId, staffId]);

  const sessions = useInfiniteQuery({
    queryKey: ['sessions', 'company', filters],
    queryFn: ({ pageParam }) => listSessions({ ...filters, limit: SESSION_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last?.meta?.nextCursor ?? undefined,
  });
  // Filter menus only — never a gate on the list.
  const clients = useQuery({ queryKey: ['clients', 'opts', 100], queryFn: () => listClients({ limit: 100 }), staleTime: 60_000 });
  const staff = useQuery({ queryKey: ['staff', 'opts', 100], queryFn: () => listStaff({ limit: 100 }), staleTime: 60_000 });
  const clientOpts = [{ value: '', label: 'All clients' }, ...(clients.data?.items ?? []).map((c) => ({ value: c.id, label: formatFullName(c) }))];
  const staffOpts = [{ value: '', label: 'All clinicians' }, ...(staff.data?.items ?? []).map((s) => ({ value: s.id, label: formatFullName(s) }))];

  const rows = useMemo(() => (sessions.data?.pages ?? []).flatMap((p) => p.items ?? []), [sessions.data]);
  const today = civilDateString(new Date(), timeZone || 'UTC');
  const term = search.trim().toLowerCase();
  const visible = useMemo(() => (term
    ? rows.filter((r) => `${r.childName ?? ''} ${r.clinicianName ?? ''}`.toLowerCase().includes(term))
    : rows), [rows, term]);

  // Real counts of the sessions loaded for the current filters (labelled as such).
  const summary = useMemo(() => {
    let todayCount = 0; let inProgress = 0; let completed = 0; let minutes = 0;
    for (const r of rows) {
      const at = sessionInstant(r);
      if (at && civilDateString(at, timeZone || 'UTC') === today) todayCount += 1;
      if (r.status === 'IN_PROGRESS') inProgress += 1;
      if (COMPLETED.has(r.status)) completed += 1;
      if (r.workedMinutes != null) minutes += Number(r.workedMinutes) || 0;
    }
    return { total: rows.length, todayCount, inProgress, completed, minutes };
  }, [rows, today, timeZone]);

  const hasMore = Boolean(sessions.hasNextPage);
  const filtered = Boolean(status || clientId || staffId || term);
  // Optional: warm the detail while the pointer/focus is on a row (same query key and freshness as the detail page).
  const prefetch = (id) => qc.prefetchQuery({ queryKey: ['session', id], queryFn: () => getSession(id), staleTime: SESSION_DETAIL_STALE_MS });

  return (
    <div className="rx-ss">
      <header className="rx-ss__head">
        <div>
          <h1 className="rx-ss__title">Sessions</h1>
          <p className="rx-ss__subtitle">Every session across your organization, with clinician, time and status.</p>
        </div>
        <Link className="rx-ss__insights" to="/sessions/oversight"><Icon.Chart size={15} aria-hidden="true" /> Session Insights</Link>
      </header>

      <dl className="rx-ss__stats" aria-label="Loaded sessions summary">
        <Stat tone="violet" icon={Icon.Clipboard} label={hasMore ? 'Sessions loaded' : 'Sessions'} value={sessions.isLoading ? null : summary.total} />
        <Stat tone="blue" icon={Icon.Calendar} label="Today" value={sessions.isLoading ? null : summary.todayCount} />
        <Stat tone="amber" icon={Icon.Clock} label="In progress" value={sessions.isLoading ? null : summary.inProgress} />
        <Stat tone="teal" icon={Icon.CheckCircle} label="Completed" value={sessions.isLoading ? null : summary.completed} />
        <Stat tone="green" icon={Icon.Chart} label="Worked time" value={sessions.isLoading ? null : (workedLabel(summary.minutes) ?? '0m')} />
      </dl>
      {hasMore && !sessions.isLoading && <p className="rx-ss__scope" role="status">Summary covers the {summary.total} most recent sessions loaded. Load more to include older sessions.</p>}

      <div className="rx-ss__filters" role="search">
        <label className="rx-ss__search">
          <Icon.Search size={17} aria-hidden="true" />
          <span className="rx-st__sr">Search loaded sessions by child or clinician</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search child or clinician" />
        </label>
        <div className="rx-ss__filter"><Select value={clientId} onChange={setClientId} options={clientOpts} loading={clients.isLoading} placeholder="All clients" /></div>
        <div className="rx-ss__filter"><Select value={staffId} onChange={setStaffId} options={staffOpts} loading={staff.isLoading} placeholder="All clinicians" /></div>
        <div className="rx-ss__filter"><Select value={status} onChange={setStatus} options={STATUS_OPTS} searchable={false} placeholder="All statuses" /></div>
        {filtered && <Button variant="ghost" size="sm" onClick={() => { setStatus(''); setClientId(''); setStaffId(''); setSearch(''); }}>Clear filters</Button>}
      </div>

      {sessions.isLoading ? (
        <ul className="rx-ss__list" aria-busy="true" aria-label="Loading sessions">
          {[0, 1, 2, 3, 4].map((i) => <li key={i} className="rx-skel rx-ss__skel" />)}
        </ul>
      ) : sessions.isError ? (
        <div className="rx-ss__state" role="alert">
          <span className="rx-ss__state-icon" aria-hidden="true"><Icon.Bell size={22} /></span>
          <strong>We couldn’t load sessions</strong>
          <span>{sessions.error?.response?.data?.error?.message || 'Check your connection and try again.'}</span>
          <Button onClick={() => sessions.refetch()}>Try again</Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rx-ss__state">
          <span className="rx-ss__state-icon" aria-hidden="true"><Icon.Clipboard size={22} /></span>
          <strong>{filtered ? 'No sessions match these filters' : 'No sessions yet'}</strong>
          <span>{filtered ? 'Try clearing the filters.' : 'Sessions appear here as soon as clinicians start or record them.'}</span>
          {filtered && <Button variant="subtle" onClick={() => { setStatus(''); setClientId(''); setStaffId(''); setSearch(''); }}>Clear filters</Button>}
        </div>
      ) : (
        <>
        <div className="rx-ss__tablehead" aria-hidden="true"><span>Client &amp; clinician</span><span>Clock in – clock out</span><span>Worked</span><span>Status</span></div>
        <ul className="rx-ss__list" aria-label="Sessions">
          {visible.map((r) => <SessionRow key={r.id} row={r} timeZone={timeZone} onPrefetch={prefetch} />)}
        </ul>
        </>
      )}

      {hasMore && !sessions.isLoading && (
        <div className="rx-ss__more">
          <Button variant="subtle" onClick={() => sessions.fetchNextPage()} loading={sessions.isFetchingNextPage}>Load more sessions</Button>
        </div>
      )}
    </div>
  );
}

/** One session row (shared by Company Sessions and Session Insights → Recent sessions). */
export function SessionRow({ row: r, timeZone, onPrefetch }) {
  const child = formatPersonName(r.childName || '') || 'Client';
  const at = sessionInstant(r);
  const clockIn = r.actualStart || r.startedAt;
  const clockOut = r.actualEnd || r.endedAt;
  const worked = workedLabel(r.workedMinutes);
  const tone = STATUS_TONE[r.status] ?? 'draft';
  return (
    <li className={`rx-ss__row rx-ss__row--${tone}`}>
      <Link to={`/sessions/${r.id}`} className="rx-ss__row-link" aria-label={`View session for ${child}${at ? ` on ${formatDate(at, timeZone)}` : ''}`}
        onMouseEnter={onPrefetch ? () => onPrefetch(r.id) : undefined} onFocus={onPrefetch ? () => onPrefetch(r.id) : undefined}>
        <span className="rx-ss__avatar" aria-hidden="true">{initials(child)}</span>
        <span className="rx-ss__main">
          <span className="rx-ss__child">{child}</span>
          <span className="rx-ss__meta">
            {at ? <span className="rx-ss__date"><Icon.Calendar size={13} aria-hidden="true" />{formatDate(at, timeZone)}</span> : null}
            <span className="rx-ss__clinician">
              {r.role ? <i className={`rx-ss__role rx-ss__role--${r.role.toLowerCase()}`}>{r.role}</i> : null}
              {formatPersonName(r.clinicianName || '') || 'Clinician not available'}
            </span>
            {r.source === 'MANUAL' ? <span className="rx-ss__tag">Manual entry</span> : null}
          </span>
        </span>
        <span className="rx-ss__times" aria-label="Clock in and clock out">
          <span><small>Clock-in</small>{clockIn ? formatTime(clockIn, timeZone) : '—'}</span>
          <span><small>Clock-out</small>{clockOut ? formatTime(clockOut, timeZone) : (r.status === 'IN_PROGRESS' ? 'In progress' : '—')}</span>
        </span>
        <span className="rx-ss__worked"><small>Worked</small>{worked ?? '—'}</span>
        <span className="rx-ss__status">
          <Badge tone={tone}>{sessionStatusText(r)}</Badge>
          <span className="rx-ss__view">View details <Icon.Arrow size={13} aria-hidden="true" /></span>
        </span>
      </Link>
    </li>
  );
}

function Stat({ tone, icon: IconCmp, label, value }) {
  return (
    <div className={`rx-ss__stat rx-ss__stat--${tone}`}>
      <span className="rx-ss__stat-icon" aria-hidden="true"><IconCmp size={17} /></span>
      <div><dt>{label}</dt><dd>{value == null ? <span className="rx-skel rx-ss__stat-skel" /> : value}</dd></div>
    </div>
  );
}

export default CompanySessionsPage;
