import { useState, useMemo } from 'react';
import { usePermissions } from '@/auth/permissions';
import { useAuthStore } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { listPlans } from '@/api/client';
import { Badge, Button, Card, ErrorState, Icon } from '@/ui';
import { formatDate } from '@/lib/format';

/**
 * Treatment plans roster (route: /plans).
 *
 * Built from the shared Staff / Clients list system (rx-st__head, rx-st__toolbar,
 * rx-st__panel with one column definition for the header and every row), so it
 * reads as part of the same product with Treatment Plan content.
 *
 * Data comes from GET /api/v1/plans via listPlans(), which maps the API's
 * { data, meta } envelope to { items, meta }, with the existing status filter
 * and cursor pagination. The server decides what statuses a caller may see (an
 * RBT is narrowed to ACTIVE server-side), so this page never fabricates, mocks,
 * or swallows errors into an empty list.
 *
 * Status filter values are the backend enums (DRAFT / ACTIVE / ARCHIVED); only
 * the *labels* are humanised, so a raw enum never reaches the screen.
 */
const PAGE_SIZE = 25;
const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ARCHIVED', label: 'Archived' },
];

/** Plain enum → sentence-case label ("IN_PROGRESS" → "In progress"). Plan
 *  enums are not session statuses, so the session label map is not used. */
function humanize(value) {
  if (!value) return '';
  const s = String(value).replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function PlansListPage() {
  const navigate = useNavigate();
  const { permissions } = usePermissions();
  const canCreate = permissions.includes('plans.create');
  const canEdit = permissions.includes('plans.update');
  // Same page for every portal; only the wording follows the reader. The RBT's
  // sidebar calls this "Programs" and the plans are view-only for them.
  const shell = shellForRoles(useAuthStore((s) => s.principal?.roles) ?? []);

  const [status, setStatus] = useState('');
  const params = { limit: PAGE_SIZE, ...(status ? { status } : {}) };

  const query = useInfiniteQuery({
    queryKey: ['plans', params],
    queryFn: ({ pageParam }) => listPlans({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last?.meta?.nextCursor ?? undefined,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items ?? []) ?? [], [query.data]);

  // Counted from the plans the server returned for this view — never invented,
  // so the numbers always agree with the rows below.
  const counts = useMemo(() => ({
    total: items.length,
    active: items.filter((p) => p.status === 'ACTIVE').length,
    draft: items.filter((p) => p.status === 'DRAFT').length,
    archived: items.filter((p) => p.status === 'ARCHIVED').length,
  }), [items]);

  return (
    <div className="rx-st rx-tp mx-auto w-full max-w-7xl">
      <header className="rx-st__head">
        <div className="rx-st__head-text">
          <h1 className="rx-st__title">{shell === 'rbt' ? 'Programs' : 'Treatment Plans'}</h1>
          <p className="rx-st__subtitle">{shell === 'rbt'
            ? 'Treatment plans for your clients, maintained by their BCBA. View only.'
            : shell === 'bcba' ? 'Goals, programs and targets for your caseload.' : 'Goals, programs and targets for each client’s care, in one place.'}</p>
        </div>
        {canCreate && <Button icon={Icon.Plus} onClick={() => navigate('/plans/new')}>New plan</Button>}
      </header>

      {query.isSuccess && items.length > 0 && (
        <section className="rx-cl__summary rx-tp__summary" aria-label="Treatment plan summary">
          {[
            { key: 'total', tone: 'blue', icon: Icon.Clipboard, label: 'Total plans', value: counts.total },
            { key: 'active', tone: 'green', icon: Icon.CheckCircle, label: 'Active', value: counts.active },
            { key: 'draft', tone: 'amber', icon: Icon.Doc, label: 'Draft', value: counts.draft },
            { key: 'archived', tone: 'violet', icon: Icon.Return, label: 'Archived', value: counts.archived },
          ].map((c) => (
            <div key={c.key} className={`rx-cl__stat rx-cl__stat--${c.tone}`}>
              <span className="rx-cl__stat-icon" aria-hidden="true"><c.icon size={18} /></span>
              <span className="rx-cl__stat-body">
                <span className="rx-cl__stat-label">{c.label}</span>
                <span className="rx-cl__stat-value">{c.value}</span>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="rx-st__toolbar" aria-label="Filter treatment plans">
        <div className="rx-st__filters" role="radiogroup" aria-label="Status">
          {STATUS_FILTERS.map((f) => (
            <button key={f.value || 'all'} type="button" role="radio" aria-checked={status === f.value}
              className={`rx-st__filter${status === f.value ? ' is-active' : ''}`} onClick={() => setStatus(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
      </section>

      <Card className="rx-st__panel rx-tp__panel" pad={false}>
        {query.isLoading ? (
          <ListSkeleton />
        ) : query.isError ? (
          <ErrorState title="We couldn’t load treatment plans" body="Please try again in a moment." onRetry={() => query.refetch()} />
        ) : items.length === 0 ? (
          <div className="rx-st__empty">
            <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Clipboard size={22} /></span>
            {status ? (
              <>
                <div className="rx-st__empty-title">No {humanize(status).toLowerCase()} plans</div>
                <p className="rx-st__empty-body">Try a different status, or show all plans.</p>
                <Button variant="ghost" onClick={() => setStatus('')}>Show all plans</Button>
              </>
            ) : (
              <>
                <div className="rx-st__empty-title">No treatment plans yet</div>
                <p className="rx-st__empty-body">{canCreate ? 'Create a treatment plan to set goals for a client.' : 'Treatment plans will appear here once they are created.'}</p>
                {canCreate && <Button icon={Icon.Plus} onClick={() => navigate('/plans/new')}>New plan</Button>}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="rx-st__listhead" aria-hidden="true">
              <span>Treatment plan</span><span>Client</span><span>BCBA</span><span>Status</span><span>Last updated</span><span className="rx-st__listhead-actions">Actions</span>
            </div>
            <ul className="rx-st__list" aria-label="Treatment plans">
              {items.map((p) => <PlanRow key={p.id} plan={p} canEdit={canEdit} onOpen={() => navigate(`/plans/${p.id}`)} />)}
            </ul>
            <footer className="rx-st__foot">
              <span className="rx-st__count">
                Showing {items.length} treatment plan{items.length === 1 ? '' : 's'}{query.hasNextPage ? ' — more available' : ''}
              </span>
              {query.hasNextPage && (
                <Button variant="ghost" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>Load more</Button>
              )}
            </footer>
          </>
        )}
      </Card>
    </div>
  );
}

function PlanRow({ plan: p, canEdit, onOpen }) {
  const title = p.title || 'Untitled plan';
  const client = p.clientName || p.childName;
  const bcba = p.bcbaName || p.authorName;
  // Only fields the API returned; a missing one is omitted, never a placeholder.
  const details = [
    p.effectiveDate ? `Effective ${formatDate(p.effectiveDate)}` : null,
    p.goalCount != null ? `${p.goalCount} goal${p.goalCount === 1 ? '' : 's'}` : null,
    p.programCount != null ? `${p.programCount} program${p.programCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  return (
    <li className="rx-st__row" onClick={onOpen}>
      <div className="rx-st__who">
        <span className="rx-st__avatar rx-tp__icon" aria-hidden="true"><Icon.Clipboard size={18} /></span>
        <div className="rx-st__who-text">
          <Link to={`/plans/${p.id}`} className="rx-st__name" onClick={(e) => e.stopPropagation()}>{title}</Link>
          {details.length > 0 && <div className="rx-st__sub"><span>{details.join(' · ')}</span></div>}
        </div>
      </div>
      <div className="rx-st__cell" data-label="Client">{client || <span className="rx-st__muted">—</span>}</div>
      <div className="rx-st__cell" data-label="BCBA">{bcba || <span className="rx-st__muted">—</span>}</div>
      <div className="rx-st__cell" data-label="Status"><Badge status={p.status}>{humanize(p.status)}</Badge></div>
      <div className="rx-st__cell" data-label="Last updated">{p.updatedAt ? formatDate(p.updatedAt) : <span className="rx-st__muted">—</span>}</div>
      <div className="rx-st__actions" onClick={(e) => e.stopPropagation()}>
        {canEdit && p.status !== 'ARCHIVED' && <Link className="rx-st__action" to={`/plans/${p.id}/edit`} aria-label={`Edit ${title}`}>Edit</Link>}
        <Link className="rx-st__action rx-st__action--primary" to={`/plans/${p.id}`} aria-label={`Open ${title}`}>View <Icon.Arrow size={14} /></Link>
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="rx-st__skeleton" aria-busy="true" aria-label="Loading treatment plans">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="rx-st__skel-row">
          <div className="rx-skel rx-st__skel-avatar" />
          <div style={{ flex: 1 }}><div className="rx-skel" style={{ height: 12, width: '38%' }} /><div className="rx-skel" style={{ height: 10, width: '24%', marginTop: 8 }} /></div>
          <div className="rx-skel" style={{ height: 22, width: 64, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}

export default PlansListPage;
