import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getClientsSummary, listClients } from '@/api/client';
import { usePermissions } from '@/auth/permissions';
import { Badge, Button, Card, ErrorState, Icon, Select } from '@/ui';
import { formatPersonName, formatStatusLabel } from '@/lib/format';

/**
 * CLIENTS — the Company Admin client roster.
 *
 * Data (all server-side, tenant- and scope-filtered):
 *   GET /v1/clients/summary   total, ACCOUNT status and referral-stage counts
 *   GET /v1/clients           rows with the server-derived `accountStatus`,
 *                             referral stage (`status`), intake, FBA/ABA
 *                             authorization status, current care team, hours;
 *                             `search`, `accountStatus`, `status` and cursor
 *                             pagination are applied by the API.
 *
 * Status types are kept separate: Account (Active / Hold / Discharged) is never
 * the referral stage (Referred / Intake), which is shown with the client.
 */

const PAGE_SIZE = 25;
const ACCOUNT_FILTERS = [
  { value: '', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'HOLD', label: 'Hold' },
  { value: 'DISCHARGED', label: 'Discharged' },
];
const STAGE_OPTIONS = [
  { value: '', label: 'All stages' },
  ...['REFERRED', 'INTAKE', 'ACTIVE', 'ON_HOLD', 'DISCHARGED'].map((v) => ({ value: v, label: formatStatusLabel(v) })),
];
const ACCOUNT_TONE = { ACTIVE: 'approved', HOLD: 'pending', DISCHARGED: 'draft' };
const INTAKE_TONE = { COMPLETE: 'approved', MISSING_DOCUMENTS: 'denied', NOT_SENT: 'draft' };
const AUTH_TONE = { APPROVED: 'approved', DENIED: 'denied', SENT: 'info', NOT_SENT: 'draft' };
/** Referral stages shown beside the client (the account column never shows these). */
const STAGE_CHIP = new Set(['REFERRED', 'INTAKE']);

function useDebounced(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const id = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return debounced;
}

const initialsOf = (name = '') => {
  const parts = String(name).replace(',', ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '—';
};
/** Care-team names arrive as "Last, First"; show "First Last". */
const staffDisplayName = (name) => {
  if (!name) return null;
  const [last, first] = String(name).split(',').map((p) => p.trim());
  return formatPersonName(first ? `${first} ${last}` : last);
};
const authStatus = (row, type) => (row.serviceAuthorizations ?? []).find((a) => a.serviceType === type)?.status ?? 'NOT_SENT';

export function ClientsListRedesign() {
  const navigate = useNavigate();
  const { permissions } = usePermissions();
  const canCreate = permissions.includes('clients.create');
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('');
  const [stage, setStage] = useState('');
  const term = useDebounced(search.trim());

  const params = { limit: PAGE_SIZE, ...(term ? { search: term } : {}), ...(account ? { accountStatus: account } : {}), ...(stage ? { status: stage } : {}) };
  const query = useInfiniteQuery({
    queryKey: ['clients', 'list', params],
    queryFn: ({ pageParam }) => listClients({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last?.meta?.nextCursor ?? undefined,
  });
  const summary = useQuery({ queryKey: ['clients', 'summary'], queryFn: getClientsSummary });
  const rows = query.data?.pages.flatMap((p) => p.items ?? []) ?? [];
  const filtered = Boolean(term || account || stage);
  const clearFilters = () => { setSearch(''); setAccount(''); setStage(''); };

  return (
    <div className="rx-cl">
      <header className="rx-cl__head">
        <div className="rx-cl__head-text">
          <h1 className="rx-cl__title">Clients</h1>
          <p className="rx-cl__subtitle">Track account readiness, intake, authorizations and care teams.</p>
        </div>
        {canCreate && <Button icon={Icon.Plus} onClick={() => navigate('/clients/new')}>Add Client</Button>}
      </header>

      <SummaryCards summary={summary} account={account} onAccount={setAccount} />

      <section className="rx-cl__toolbar" aria-label="Search and filter clients">
        <label className="rx-st__search rx-cl__search">
          <Icon.Search size={18} aria-hidden="true" />
          <span className="rx-st__sr">Search clients</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or client number" maxLength={100} />
          {search && <button type="button" className="rx-st__clear" onClick={() => setSearch('')} aria-label="Clear search"><Icon.Close size={15} /></button>}
        </label>
        <div className="rx-st__filters" role="radiogroup" aria-label="Account status">
          {ACCOUNT_FILTERS.map((f) => (
            <button key={f.value || 'all'} type="button" role="radio" aria-checked={account === f.value}
              className={`rx-st__filter${account === f.value ? ' is-active' : ''}`} onClick={() => setAccount(f.value)}>
              {f.value && <span className={`rx-cl__dot rx-cl__dot--${f.value.toLowerCase()}`} aria-hidden="true" />}
              {f.label}
            </button>
          ))}
        </div>
        <div className="rx-cl__stage" aria-label="Referral stage">
          <Select value={stage} onChange={(v) => setStage(v || '')} options={STAGE_OPTIONS} searchable={false} />
        </div>
      </section>

      <Card className="rx-cl__panel" pad={false}>
        {query.isLoading ? (
          <TableSkeleton />
        ) : query.isError ? (
          <ErrorState title="We couldn’t load your clients" body="Please try again in a moment." onRetry={() => query.refetch()} />
        ) : rows.length === 0 ? (
          filtered ? (
            <div className="rx-st__empty">
              <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Search size={22} /></span>
              <div className="rx-st__empty-title">No clients match your filters</div>
              <p className="rx-st__empty-body">Try a different name or client number, or clear the filters.</p>
              <Button variant="ghost" onClick={clearFilters}>Clear filters</Button>
            </div>
          ) : (
            <div className="rx-st__empty">
              <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Child size={22} /></span>
              <div className="rx-st__empty-title">No clients yet</div>
              <p className="rx-st__empty-body">Add your first client to start intake, authorizations and scheduling.</p>
              {canCreate && <Button icon={Icon.Plus} onClick={() => navigate('/clients/new')}>Add Client</Button>}
            </div>
          )
        ) : (
          <>
            <div className="rx-cl__listhead" aria-hidden="true">
              <span>Client</span><span>Account</span><span>Care team</span><span>Intake</span><span>Authorizations</span><span className="rx-cl__num">Hours/wk</span><span className="rx-cl__listhead-actions">Actions</span>
            </div>
            <ul className="rx-cl__list" aria-label="Clients">
              {rows.map((c) => <ClientRow key={c.id} client={c} onOpen={() => navigate(`/clients/${c.id}`)} />)}
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

function SummaryCards({ summary, account, onAccount }) {
  if (summary.isLoading) {
    return <div className="rx-cl__summary" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="rx-skel rx-cl__stat-skel" />)}</div>;
  }
  if (summary.isError || !summary.data) return null;
  const s = summary.data;
  const inReferral = (s.stage?.REFERRED ?? 0) + (s.stage?.INTAKE ?? 0);
  const cards = [
    { key: 'total', tone: 'violet', icon: Icon.Users, label: 'Total clients', value: s.total, hint: s.account.DISCHARGED ? `${s.account.DISCHARGED} discharged` : 'Across your organization', filter: '' },
    { key: 'active', tone: 'green', icon: Icon.CheckCircle, label: 'Active', value: s.account.ACTIVE, hint: 'Parent/guardian details on file', filter: 'ACTIVE' },
    { key: 'hold', tone: 'amber', icon: Icon.Bell, label: 'Hold', value: s.account.HOLD, hint: 'Needs parent details or on hold', filter: 'HOLD' },
    { key: 'referral', tone: 'blue', icon: Icon.Inbox, label: 'Referral & intake', value: inReferral, hint: 'Clients in referred or intake stage', filter: null },
  ];
  return (
    <section className="rx-cl__summary" aria-label="Client summary">
      {cards.map((c) => {
        const body = (
          <>
            <span className="rx-cl__stat-icon" aria-hidden="true"><c.icon size={18} /></span>
            <span className="rx-cl__stat-body">
              <span className="rx-cl__stat-label">{c.label}</span>
              <span className="rx-cl__stat-value">{c.value}</span>
              <span className="rx-cl__stat-hint">{c.hint}</span>
            </span>
          </>
        );
        return c.filter === null ? (
          <div key={c.key} className={`rx-cl__stat rx-cl__stat--${c.tone}`}>{body}</div>
        ) : (
          <button key={c.key} type="button" className={`rx-cl__stat rx-cl__stat--${c.tone}${account === c.filter ? ' is-active' : ''}`}
            aria-pressed={account === c.filter} onClick={() => onAccount(c.filter)} aria-label={`${c.label}: ${c.value}. Show ${c.label === 'Total clients' ? 'all clients' : `${c.label} clients`}`}>
            {body}
          </button>
        );
      })}
    </section>
  );
}

function ClientRow({ client, onOpen }) {
  const name = formatPersonName([client.firstName, client.lastName].filter(Boolean).join(' ')) || 'Client';
  const account = client.accountStatus ?? 'HOLD';
  const intake = client.intakeWorkflowStatus || 'NOT_SENT';
  const bcba = staffDisplayName(client.careTeam?.bcba?.name);
  const rbt = staffDisplayName(client.careTeam?.rbt?.name);
  return (
    <li className="rx-cl__row" onClick={onOpen}>
      <div className="rx-cl__who">
        <span className={`rx-cl__avatar rx-cl__avatar--${account.toLowerCase()}`} aria-hidden="true">{initialsOf(name)}</span>
        <div className="rx-cl__who-text">
          <Link to={`/clients/${client.id}`} className="rx-cl__name" onClick={(e) => e.stopPropagation()}>{name}</Link>
          <div className="rx-cl__meta">
            {client.clientNumber && <span>{client.clientNumber}</span>}
            {STAGE_CHIP.has(client.status) && <span className="rx-cl__stage-chip" title="Referral stage">{formatStatusLabel(client.status)}</span>}
          </div>
        </div>
      </div>
      <div className="rx-cl__cell" data-label="Account">
        <Badge tone={ACCOUNT_TONE[account] ?? 'draft'}>{formatStatusLabel(account)}</Badge>
      </div>
      <div className="rx-cl__cell rx-cl__team" data-label="Care team">
        <TeamMember role="BCBA" name={bcba} />
        <TeamMember role="RBT" name={rbt} />
      </div>
      <div className="rx-cl__cell" data-label="Intake">
        <Badge tone={INTAKE_TONE[intake] ?? 'info'}>{formatStatusLabel(intake)}</Badge>
      </div>
      <div className="rx-cl__cell rx-cl__auths" data-label="Authorizations">
        {['FBA', 'ABA'].map((type) => {
          const st = authStatus(client, type);
          return (
            <span key={type} className="rx-cl__auth">
              <span className="rx-cl__auth-type">{type}</span>
              <Badge tone={AUTH_TONE[st] ?? 'info'} dot={false}>{formatStatusLabel(st)}</Badge>
            </span>
          );
        })}
      </div>
      <div className="rx-cl__cell rx-cl__num" data-label="Hours/wk">
        {client.approvedWeeklyHours == null ? <span className="rx-st__muted">Not set</span> : `${client.approvedWeeklyHours} hrs`}
      </div>
      <div className="rx-cl__actions" onClick={(e) => e.stopPropagation()}>
        <Link className="rx-st__action rx-st__action--primary" to={`/clients/${client.id}`} aria-label={`Open ${name}`}>View <Icon.Arrow size={14} /></Link>
      </div>
    </li>
  );
}

function TeamMember({ role, name }) {
  return (
    <span className={`rx-cl__member${name ? '' : ' is-empty'}`}>
      <span className={`rx-cl__member-role rx-cl__member-role--${role.toLowerCase()}`}>{role}</span>
      <span className="rx-cl__member-name">{name ?? 'Not assigned'}</span>
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className="rx-st__skeleton" aria-busy="true" aria-label="Loading clients">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="rx-st__skel-row">
          <div className="rx-skel rx-st__skel-avatar" />
          <div style={{ flex: 1 }}><div className="rx-skel" style={{ height: 12, width: '34%' }} /><div className="rx-skel" style={{ height: 10, width: '18%', marginTop: 8 }} /></div>
          <div className="rx-skel" style={{ height: 22, width: 70, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}

export default ClientsListRedesign;
