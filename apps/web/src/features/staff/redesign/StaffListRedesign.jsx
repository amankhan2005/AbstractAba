import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { listStaff } from '@/api/client';
import { usePermissions } from '@/auth/permissions';
import { Badge, Button, Card, ErrorState, Icon } from '@/ui';
import { formatDate, formatFullName } from '@/lib/format';

/**
 * STAFF — the Company Admin's team directory.
 *
 * Data: GET /v1/staff (tenant- and scope-filtered on the server) with the
 * existing `search`, `status` and cursor pagination. Rows show only fields the
 * staff record carries: name, login email, RBAC role(s), title, employee ID,
 * start date and status. Opening a row goes to the staff profile.
 */

const PAGE_SIZE = 25;
const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
];
const ROLE_LABELS = { bcba: 'BCBA', rbt: 'RBT', manager: 'Manager', owner: 'Owner', org_admin: 'Admin' };
const ROLE_TONE = { bcba: 'bcba', rbt: 'rbt' };

export const staffRoleLabel = (key) => ROLE_LABELS[key] ?? key;
const initials = (s) => (`${s.firstName?.[0] ?? ''}${s.lastName?.[0] ?? ''}`.toUpperCase() || '—');

/** Debounced value — search hits the API after typing pauses, not on every key. */
function useDebounced(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** Role mix and status of the staff shown — counted from the loaded rows, never estimated. */
function WorkforceStrip({ rows }) {
  const count = (fn) => rows.filter(fn).length;
  const bcba = count((s) => (s.roleKeys ?? []).includes('bcba'));
  const rbt = count((s) => (s.roleKeys ?? []).includes('rbt') && !(s.roleKeys ?? []).includes('bcba'));
  const other = rows.length - bcba - rbt;
  const active = count((s) => s.status === 'ACTIVE');
  const segments = [
    { key: 'bcba', label: 'BCBA', value: bcba },
    { key: 'rbt', label: 'RBT', value: rbt },
    { key: 'other', label: 'Other roles', value: other },
  ].filter((x) => x.value > 0);
  return (
    <section className="rx-st__workforce" aria-label="Team composition">
      <div className="rx-st__workforce-figures">
        <div><span className="rx-st__workforce-value">{rows.length}</span><span className="rx-st__workforce-label">Staff members</span></div>
        <div><span className="rx-st__workforce-value">{active}</span><span className="rx-st__workforce-label">Active</span></div>
        <div><span className="rx-st__workforce-value">{rows.length - active}</span><span className="rx-st__workforce-label">Inactive</span></div>
      </div>
      <div className="rx-st__workforce-mix">
        <div className="rx-st__workforce-bar" aria-hidden="true">
          {segments.map((x) => <span key={x.key} className={`rx-st__workforce-seg rx-st__workforce-seg--${x.key}`} style={{ flexGrow: x.value }} />)}
        </div>
        <ul className="rx-st__workforce-legend">
          {segments.map((x) => <li key={x.key}><span className={`rx-st__workforce-dot rx-st__workforce-seg--${x.key}`} aria-hidden="true" />{x.label} <strong>{x.value}</strong></li>)}
        </ul>
      </div>
    </section>
  );
}

export function StaffListRedesign() {
  const navigate = useNavigate();
  const { permissions } = usePermissions();
  const canManage = permissions.includes('staff.manage');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const term = useDebounced(search.trim());

  const params = { limit: PAGE_SIZE, ...(term ? { search: term } : {}), ...(status ? { status } : {}) };
  const query = useInfiniteQuery({
    queryKey: ['staff', 'list', params],
    queryFn: ({ pageParam }) => listStaff({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last?.meta?.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.items ?? []) ?? [];
  const filtered = Boolean(term || status);

  return (
    <div className="rx-st">
      <header className="rx-st__head">
        <div className="rx-st__head-text">
          <h1 className="rx-st__title">Staff</h1>
          <p className="rx-st__subtitle">Your clinical and administrative team — roles, status and profiles in one place.</p>
        </div>
        {canManage && (
          <Button icon={Icon.Plus} onClick={() => navigate('/staff/new')}>Add staff</Button>
        )}
      </header>

      {rows.length > 0 && <WorkforceStrip rows={rows} />}

      <section className="rx-st__toolbar" aria-label="Search and filter staff">
        <label className="rx-st__search">
          <Icon.Search size={18} aria-hidden="true" />
          <span className="rx-st__sr">Search staff</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or employee ID" maxLength={100} />
          {search && <button type="button" className="rx-st__clear" onClick={() => setSearch('')} aria-label="Clear search"><Icon.Close size={15} /></button>}
        </label>
        <div className="rx-st__filters" role="radiogroup" aria-label="Status">
          {STATUS_FILTERS.map((f) => (
            <button key={f.value || 'all'} type="button" role="radio" aria-checked={status === f.value}
              className={`rx-st__filter${status === f.value ? ' is-active' : ''}`} onClick={() => setStatus(f.value)}>
              {f.value && <span className={`rx-st__dot rx-st__dot--${f.value.toLowerCase()}`} aria-hidden="true" />}
              {f.label}
            </button>
          ))}
        </div>
      </section>

      <Card className="rx-st__panel" pad={false}>
        {query.isLoading ? (
          <ListSkeleton />
        ) : query.isError ? (
          <ErrorState title="We couldn’t load your staff" body="Please try again in a moment." onRetry={() => query.refetch()} />
        ) : rows.length === 0 ? (
          filtered ? (
            <div className="rx-st__empty">
              <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Search size={22} /></span>
              <div className="rx-st__empty-title">No staff match your search</div>
              <p className="rx-st__empty-body">Try a different name or employee ID, or clear the filters.</p>
              <Button variant="ghost" onClick={() => { setSearch(''); setStatus(''); }}>Clear filters</Button>
            </div>
          ) : (
            <div className="rx-st__empty">
              <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Users size={22} /></span>
              <div className="rx-st__empty-title">No staff yet</div>
              <p className="rx-st__empty-body">Add your first BCBA or RBT to start building care teams.</p>
              {canManage && <Button icon={Icon.Plus} onClick={() => navigate('/staff/new')}>Add staff</Button>}
            </div>
          )
        ) : (
          <>
            <div className="rx-st__listhead" aria-hidden="true">
              <span>Staff member</span><span>Role</span><span>Employee ID</span><span>Start date</span><span>Status</span><span className="rx-st__listhead-actions">Actions</span>
            </div>
            <ul className="rx-st__list" aria-label="Staff members">
              {rows.map((s) => <StaffRow key={s.id} staff={s} canManage={canManage} onOpen={() => navigate(`/staff/${s.id}`)} />)}
            </ul>
            <footer className="rx-st__foot">
              <span className="rx-st__count">
                Showing {rows.length} staff member{rows.length === 1 ? '' : 's'}{query.hasNextPage ? ' — more available' : ''}
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

function StaffRow({ staff, canManage, onOpen }) {
  const roles = staff.roleKeys ?? [];
  const tone = ROLE_TONE[roles.find((k) => ROLE_TONE[k])] ?? 'default';
  const name = formatFullName(staff) || 'Staff member';
  const active = staff.status === 'ACTIVE';
  return (
    <li className="rx-st__row" onClick={onOpen}>
      <div className="rx-st__who">
        <span className={`rx-st__avatar rx-st__avatar--${tone}`} aria-hidden="true">{initials(staff)}</span>
        <div className="rx-st__who-text">
          <Link to={`/staff/${staff.id}`} className="rx-st__name" onClick={(e) => e.stopPropagation()}>{name}</Link>
          <div className="rx-st__sub">
            {staff.email && <span className="rx-st__email" title={staff.email}>{staff.email}</span>}
            {staff.title && <span className="rx-st__staff-title">{staff.title}</span>}
          </div>
        </div>
      </div>
      <div className="rx-st__cell" data-label="Role">
        {roles.length ? roles.map((k) => <span key={k} className={`rx-st__role rx-st__role--${ROLE_TONE[k] ?? 'default'}`}>{staffRoleLabel(k)}</span>)
          : <span className="rx-st__muted">No role</span>}
      </div>
      <div className="rx-st__cell" data-label="Employee ID">{staff.employeeNumber ?? <span className="rx-st__muted">—</span>}</div>
      <div className="rx-st__cell" data-label="Start date">{staff.startDate ? formatDate(staff.startDate) : <span className="rx-st__muted">—</span>}</div>
      <div className="rx-st__cell" data-label="Status">
        <Badge tone={active ? 'approved' : 'draft'}>{active ? 'Active' : 'Inactive'}</Badge>
      </div>
      <div className="rx-st__actions" onClick={(e) => e.stopPropagation()}>
        {canManage && <Link className="rx-st__action" to={`/staff/${staff.id}/edit`} aria-label={`Edit ${name}`}>Edit</Link>}
        <Link className="rx-st__action rx-st__action--primary" to={`/staff/${staff.id}`} aria-label={`Open ${name}`}>View <Icon.Arrow size={14} /></Link>
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="rx-st__skeleton" aria-busy="true" aria-label="Loading staff">
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

export default StaffListRedesign;
