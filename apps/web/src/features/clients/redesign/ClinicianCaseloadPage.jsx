import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { listClients, listPlans } from '@/api/client';
import { useAuthStore, useOrgTimezone } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { Badge, Button, Card, ErrorState, Icon, PageHeader } from '@/ui';
import { formatPersonName, formatStatusLabel } from '@/lib/format';
import { appointmentOccurrence, groupSessionCards, occurrenceText } from '@/lib/appointment.js';
import { useBcbaActiveSession, useRbtActiveSession } from '@/features/sessions/useBcbaSession.js';
import { ClientsListRedesign } from './ClientsListRedesign.jsx';

/**
 * CLIENTS — the clinician's caseload (BCBA "My Caseload", RBT "Clients").
 *
 * The Company Admin keeps the organization Clients page (account readiness,
 * intake, authorizations, hours). A clinician sees their own caseload as
 * clinical context instead: status, next session, treatment plan and — for the
 * BCBA — the assigned RBT.
 *
 * Real, server-scoped data only, from APIs the portal already uses:
 *   clients       GET /v1/clients (the caller's caseload, search)
 *   plans         GET /v1/plans   (active plan per client)
 *   next session  the clinician's own session panel (/bcba or /rbt panel),
 *                 the same cards the dashboard shows — no extra request.
 */
const PAGE_SIZE = 25;
const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'HOLD', label: 'On hold' },
];
const ACCOUNT_TONE = { ACTIVE: 'approved', HOLD: 'pending', DISCHARGED: 'draft' };

function useDebounced(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const id = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return debounced;
}
const initialsOf = (name = '') => {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '—';
};

/** Route element for /clients: the organization page for admins, the caseload for clinicians. */
export function ClientsIndexRoute() {
  const roles = useAuthStore((s) => s.principal?.roles) ?? [];
  const shell = shellForRoles(roles);
  if (shell === 'bcba') return <BcbaCaseload />;
  if (shell === 'rbt') return <RbtCaseload />;
  return <ClientsListRedesign />;
}

function BcbaCaseload() {
  const { cards } = useBcbaActiveSession();
  return <ClinicianCaseloadPage role="bcba" cards={cards} rbtNameFor={(c) => (c.careTeam?.rbt?.name ? displayStaff(c.careTeam.rbt.name) : null)} />;
}

function RbtCaseload() {
  const { cards } = useRbtActiveSession();
  return <ClinicianCaseloadPage role="rbt" cards={cards} />;
}

/** Care-team names arrive as "Last, First"; show "First Last". */
function displayStaff(name) {
  const [last, first] = String(name).split(',').map((p) => p.trim());
  return formatPersonName(first ? `${first} ${last}` : last);
}

export function ClinicianCaseloadPage({ role, cards = [], rbtNameFor = null }) {
  const navigate = useNavigate();
  const isBcba = role === 'bcba';
  const timeZone = useOrgTimezone();
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('');
  const term = useDebounced(search.trim());

  const params = { limit: PAGE_SIZE, ...(term ? { search: term } : {}), ...(account ? { accountStatus: account } : {}) };
  const query = useInfiniteQuery({
    queryKey: ['clients', 'caseload', params],
    queryFn: ({ pageParam }) => listClients({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last?.meta?.nextCursor ?? undefined,
  });
  const plans = useQuery({ queryKey: ['plans', { limit: 100 }], queryFn: () => listPlans({ limit: 100 }) });
  const rows = query.data?.pages.flatMap((p) => p.items ?? []) ?? [];

  // Active (else latest) treatment plan per client.
  const planByClient = useMemo(() => {
    const map = new Map();
    for (const p of plans.data?.items ?? []) {
      const prev = map.get(p.clientId);
      if (!prev || (p.status === 'ACTIVE' && prev.status !== 'ACTIVE')) map.set(p.clientId, p);
    }
    return map;
  }, [plans.data]);

  // Next open or upcoming appointment per client, from the clinician's own panel.
  const nextByClient = useMemo(() => {
    const now = new Date();
    const { current, upcoming } = groupSessionCards(cards, timeZone, now);
    const map = new Map();
    for (const card of [...current, ...upcoming]) {
      const at = appointmentOccurrence(card, timeZone, now)?.windowStart ?? card.startAt;
      const prev = map.get(card.clientId);
      if (!prev || new Date(at) < new Date(prev.at)) map.set(card.clientId, { card, at });
    }
    return map;
  }, [cards, timeZone]);

  const summary = {
    total: rows.length,
    active: rows.filter((c) => c.accountStatus === 'ACTIVE').length,
    withPlan: rows.filter((c) => planByClient.get(c.id)?.status === 'ACTIVE').length,
    scheduled: rows.filter((c) => nextByClient.has(c.id)).length,
  };
  const filtered = Boolean(term || account);

  return (
    <div className="rx-cw rx-cl-clin">
      <PageHeader
        eyebrow={isBcba ? 'Clinical supervision' : 'Caseload'}
        title={isBcba ? 'My Caseload' : 'Clients'}
        subtitle={isBcba ? 'Your assigned clients with their next session and treatment plan.' : 'The clients assigned to you, with their next session and program.'}
      />

      {query.isSuccess && rows.length > 0 && !filtered && (
        <dl className="rx-sl__stats" aria-label="Caseload summary">
          <div className="rx-sl__stat"><dt>Clients</dt><dd>{summary.total}</dd></div>
          <div className="rx-sl__stat"><dt>Active</dt><dd>{summary.active}</dd></div>
          <div className="rx-sl__stat"><dt>{isBcba ? 'With an active plan' : 'With an active program'}</dt><dd>{summary.withPlan}</dd></div>
          <div className="rx-sl__stat"><dt>Sessions scheduled</dt><dd>{summary.scheduled}</dd></div>
        </dl>
      )}

      <section className="rx-st__toolbar" aria-label="Search and filter clients">
        <label className="rx-st__search">
          <Icon.Search size={18} aria-hidden="true" />
          <span className="rx-st__sr">Search clients</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or client number" maxLength={100} />
          {search && <button type="button" className="rx-st__clear" onClick={() => setSearch('')} aria-label="Clear search"><Icon.Close size={15} /></button>}
        </label>
        <div className="rx-st__filters" role="radiogroup" aria-label="Status">
          {STATUS_FILTERS.map((f) => (
            <button key={f.value || 'all'} type="button" role="radio" aria-checked={account === f.value}
              className={`rx-st__filter${account === f.value ? ' is-active' : ''}`} onClick={() => setAccount(f.value)}>{f.label}</button>
          ))}
        </div>
      </section>

      <Card className={`rx-st__panel rx-cc__panel${isBcba ? ' rx-cc__panel--bcba' : ''}`} pad={false}>
        {query.isLoading ? (
          <div className="rx-st__skeleton" aria-busy="true" aria-label="Loading clients">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rx-st__skel-row">
                <div className="rx-skel rx-st__skel-avatar" />
                <div style={{ flex: 1 }}><div className="rx-skel" style={{ height: 12, width: '34%' }} /><div className="rx-skel" style={{ height: 10, width: '18%', marginTop: 8 }} /></div>
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <ErrorState title="We couldn’t load your clients" body="Please try again in a moment." onRetry={() => query.refetch()} />
        ) : rows.length === 0 ? (
          <div className="rx-st__empty">
            <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Child size={22} /></span>
            <div className="rx-st__empty-title">{filtered ? 'No clients match your search' : 'No clients assigned yet'}</div>
            <p className="rx-st__empty-body">{filtered ? 'Try a different name or client number, or clear the filters.' : 'Clients assigned to you by your organization appear here.'}</p>
            {filtered && <Button variant="ghost" onClick={() => { setSearch(''); setAccount(''); }}>Clear filters</Button>}
          </div>
        ) : (
          <>
            <div className="rx-st__listhead" aria-hidden="true">
              <span>Client</span><span>Status</span><span>Next session</span><span>{isBcba ? 'Treatment plan' : 'Program'}</span>{isBcba && <span>RBT</span>}<span className="rx-st__listhead-actions">Actions</span>
            </div>
            <ul className="rx-st__list" aria-label="Clients">
              {rows.map((c) => {
                const name = formatPersonName([c.firstName, c.lastName].filter(Boolean).join(' ')) || 'Client';
                const plan = planByClient.get(c.id);
                const next = nextByClient.get(c.id);
                const accountStatus = c.accountStatus ?? 'HOLD';
                const rbt = isBcba && rbtNameFor ? rbtNameFor(c) : null;
                return (
                  <li key={c.id} className="rx-st__row" onClick={() => navigate(`/clients/${c.id}`)}>
                    <div className="rx-st__who">
                      <span className="rx-st__avatar rx-cc__avatar" aria-hidden="true">{initialsOf(name)}</span>
                      <div className="rx-st__who-text">
                        <Link to={`/clients/${c.id}`} className="rx-st__name" onClick={(e) => e.stopPropagation()}>{name}</Link>
                        {c.clientNumber && <div className="rx-st__sub"><span>{c.clientNumber}</span></div>}
                      </div>
                    </div>
                    <div className="rx-st__cell" data-label="Status"><Badge tone={ACCOUNT_TONE[accountStatus] ?? 'draft'}>{formatStatusLabel(accountStatus)}</Badge></div>
                    <div className="rx-st__cell" data-label="Next session">
                      {next ? occurrenceText(next.card, timeZone, new Date(), { todayLabel: true }) : <span className="rx-st__muted">None scheduled</span>}
                    </div>
                    <div className="rx-st__cell" data-label={isBcba ? 'Treatment plan' : 'Program'} onClick={(e) => e.stopPropagation()}>
                      {plan ? (
                        <Link className="rx-cc__plan" to={`/plans/${plan.id}`}>
                          {plan.title || 'Treatment plan'}
                          {plan.status !== 'ACTIVE' && <span className="rx-st__muted"> · {formatStatusLabel(plan.status)}</span>}
                        </Link>
                      ) : <span className="rx-st__muted">{isBcba ? 'No plan yet' : 'No program yet'}</span>}
                    </div>
                    {isBcba && <div className="rx-st__cell" data-label="RBT">{rbt || <span className="rx-st__muted">Not assigned</span>}</div>}
                    <div className="rx-st__actions" onClick={(e) => e.stopPropagation()}>
                      <Link className="rx-st__action rx-st__action--primary" to={`/clients/${c.id}`} aria-label={`Open ${name}`}>View <Icon.Arrow size={14} /></Link>
                    </div>
                  </li>
                );
              })}
            </ul>
            <footer className="rx-st__foot">
              <span className="rx-st__count">Showing {rows.length} client{rows.length === 1 ? '' : 's'}{query.hasNextPage ? ' — more available' : ''}</span>
              {query.hasNextPage && <Button variant="ghost" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>Load more</Button>}
            </footer>
          </>
        )}
      </Card>
    </div>
  );
}

export default ClinicianCaseloadPage;
