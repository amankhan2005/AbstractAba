import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAllTenants } from '@/api/queries';
import {
  PageHeader, Card, Badge, Avatar, Icon, SearchInput, FilterTabs, Pagination,
  EmptyState, ErrorState, SkeletonRows,
} from '@/components';
import { formatDate } from '@/lib/format';
import { companyStatus, matchesCompanyFilter, COMPANY_FILTERS } from '@/lib/company-status';
import { InviteCompanyWizard } from './InviteCompanyWizard';

/**
 * Companies — the Super Admin company directory. Search (name, owner, email),
 * plain-language status filters with live counts, sorting and pagination, all
 * over the complete directory from the console API. Rows open the company.
 */
const PAGE_SIZE = 15;
const SORTS = {
  newest: { label: 'Newest first', fn: (a, b) => new Date(b.createdAt) - new Date(a.createdAt) },
  oldest: { label: 'Oldest first', fn: (a, b) => new Date(a.createdAt) - new Date(b.createdAt) },
  name: { label: 'Name A–Z', fn: (a, b) => (a.tradingName || a.slug || '').localeCompare(b.tradingName || b.slug || '') },
};

export function CompaniesRx() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [inviting, setInviting] = useState(false);
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, refetch, isFetching } = useAllTenants();
  const all = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const term = search.trim().toLowerCase();

  const counts = useMemo(() => {
    const c = { all: all.length };
    for (const row of all) { const g = companyStatus(row.state).group; c[g] = (c[g] ?? 0) + 1; }
    return c;
  }, [all]);

  const rows = useMemo(() => all
    .filter((c) => matchesCompanyFilter(c.state, filter))
    .filter((c) => !term
      || (c.tradingName || '').toLowerCase().includes(term)
      || (c.slug || '').toLowerCase().includes(term)
      || (c.primaryContactName || '').toLowerCase().includes(term)
      || (c.primaryContactEmail || '').toLowerCase().includes(term))
    .sort(SORTS[sort].fn), [all, filter, term, sort]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shown = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const filtered = term !== '' || filter !== 'all';
  const reset = () => { setSearch(''); setFilter('all'); setPage(0); };

  return (
    <section>
      <PageHeader
        eyebrow="Companies"
        title="Companies"
        description="Every company on the platform — their owner, status and when they joined."
        actions={(
          <>
            <Link to="/companies/invitations" className="rxc-btn rxc-btn--secondary"><Icon name="mail" size={16} /><span>Invitations</span></Link>
            <button type="button" className="rxc-btn rxc-btn--primary" onClick={() => setInviting(true)}>
              <Icon name="plus" size={17} /><span>Invite company</span>
            </button>
          </>
        )}
      />

      <Card flush>
        <div className="rxc-toolbar">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0); }} placeholder="Search by company, owner or email" label="Search companies" />
          <FilterTabs
            label="Filter by status"
            value={filter}
            onChange={(k) => { setFilter(k); setPage(0); }}
            options={COMPANY_FILTERS.map((f) => ({ ...f, count: isLoading ? null : (counts[f.key] ?? 0) }))}
          />
          <span className="rxc-toolbar__spacer" />
          <label className="sr-only" htmlFor="companies-sort">Sort companies</label>
          <select id="companies-sort" className="rxc-select" value={sort} onChange={(e) => setSort(e.target.value)}>
            {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </select>
        </div>

        {isLoading ? <SkeletonRows rows={8} label="Loading companies" />
          : isError ? <ErrorState message="The company directory couldn’t be loaded." onRetry={refetch} />
          : all.length === 0 ? (
            <EmptyState icon="building" title="No companies yet" message="Invite your first company. The owner receives a secure link to set up their account."
              action={<button type="button" className="rxc-btn rxc-btn--primary rxc-btn--sm" onClick={() => setInviting(true)}><Icon name="plus" size={15} /><span>Invite company</span></button>} />
          ) : rows.length === 0 ? (
            <EmptyState icon="search" title="No matching companies" message="Try a different search term or status filter."
              action={<button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={reset}>Clear filters</button>} />
          ) : (
            <>
              <div className="rxc-table-wrap" aria-busy={isFetching ? 'true' : undefined}>
                <table className="rxc-table rxc-table--stack">
                  <caption className="sr-only">Companies{filtered ? ' (filtered)' : ''}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Company</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Status</th>
                      <th scope="col">Created</th>
                      <th scope="col">Activated</th>
                      <th scope="col"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((c) => {
                      const st = companyStatus(c.state);
                      const name = c.tradingName || c.slug;
                      return (
                        <tr key={c.id}>
                          <td data-primary>
                            <Link to={`/companies/${c.id}`} className="rxc-entity">
                              <Avatar name={name} size="md" square />
                              <span className="rxc-entity__text">
                                <span className="rxc-entity__name">{name}</span>
                                {c.slug ? <span className="rxc-entity__sub">{c.slug}</span> : null}
                              </span>
                            </Link>
                          </td>
                          <td data-label="Owner">
                            <div>
                              <div style={{ fontWeight: 550 }}>{c.primaryContactName || '—'}</div>
                              {c.primaryContactEmail ? <span className="rxc-table__sub">{c.primaryContactEmail}</span> : null}
                            </div>
                          </td>
                          <td data-label="Status"><Badge tone={st.tone}>{st.label}</Badge></td>
                          <td data-label="Created" className="is-muted rxc-nowrap">{formatDate(c.createdAt) || '—'}</td>
                          <td data-label="Activated" className="is-muted rxc-nowrap">{formatDate(c.activatedAt) || '—'}</td>
                          <td className="is-actions">
                            <Link to={`/companies/${c.id}`} className="rxc-btn rxc-btn--secondary rxc-btn--sm" aria-label={`Manage ${name}`}>
                              <span>Manage</span><Icon name="chevronRight" size={15} />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} noun={rows.length === 1 ? 'company' : 'companies'} />
            </>
          )}
      </Card>

      {inviting && <InviteCompanyWizard onClose={() => setInviting(false)} />}
    </section>
  );
}

export default CompaniesRx;
