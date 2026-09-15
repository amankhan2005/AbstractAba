import { useState } from 'react';
import { usePermissions } from '@/auth/permissions';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { globalSearch } from '@/api/client';
import { PageHeader, Card, Icon, Spinner, EmptyState, ErrorState } from '@/ui';

/**
 * Global search — read-only, RBAC-scoped (the server authorizes each entity and
 * scopes to the tenant; we only offer type chips the caller may read). Results
 * arrive grouped by type with counts and animate in. No fabricated results.
 */
const TYPE_LABELS = { clients: 'Clients', staff: 'Staff', authorizations: 'Authorizations', documents: 'Documents' };
const READ_PERMS = { clients: 'clients.read', staff: 'staff.read', authorizations: 'scheduling.read', documents: 'documents.read' };
const TYPE_ICON = { clients: Icon.Child, staff: Icon.Users, authorizations: Icon.Shield, documents: Icon.Doc };

function linkFor(item) {
  switch (item.type) {
    case 'client': return `/clients/${item.id}`;
    case 'document': return `/documents/${item.id}`;
    default: return null;
  }
}

export function SearchRedesign() {
  const { permissions: permissions, ready: authReady } = usePermissions();
  const available = Object.keys(TYPE_LABELS).filter((t) => permissions.includes(READ_PERMS[t]));
  const [term, setTerm] = useState('');
  const [activeType, setActiveType] = useState(null);
  const [submitted, setSubmitted] = useState('');

  const query = useQuery({
    queryKey: ['search', submitted, activeType],
    queryFn: () => globalSearch({ q: submitted, ...(activeType ? { types: activeType } : {}) }),
    enabled: submitted.trim().length > 0,
  });

  const onSubmit = (e) => { e.preventDefault(); setSubmitted(term.trim()); };
  // Only surface result groups the search UI still recognises — a claims group
  // returned by the backend is never rendered as a user-facing page/link.
  const groups = query.data?.groups?.filter((g) => g.count > 0 && TYPE_LABELS[g.type]) ?? [];

  return (
    <>
      <PageHeader title="Search" subtitle="Find children, staff, documents and more — across everything you’re allowed to see." />

      <form onSubmit={onSubmit}>
        <div className="rx-input rx-input--lg" style={{ height: 52, marginBottom: 14 }}>
          <Icon.Search size={20} />
          <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search across the platform…" style={{ fontSize: '1rem' }} />
          <button type="submit" className="rx-btn rx-btn--primary" style={{ height: 38 }}>Search</button>
        </div>
      </form>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <button className={`rx-btn ${activeType === null ? 'rx-btn--subtle' : 'rx-btn--ghost'}`} onClick={() => setActiveType(null)}>All</button>
        {available.map((t) => (
          <button key={t} className={`rx-btn ${activeType === t ? 'rx-btn--subtle' : 'rx-btn--ghost'}`} onClick={() => setActiveType(t)}>
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {submitted.trim().length === 0 ? (
        <EmptyState icon={Icon.Search} title="Start typing to search" body="Results are scoped to what your role can access." />
      ) : query.isLoading ? <Spinner />
        : query.isError ? <ErrorState onRetry={() => query.refetch()} />
        : groups.length === 0 ? <EmptyState icon={Icon.Search} title={`No results for “${submitted}”`} body="Try a different term or type." />
        : (
          <div className="rx-stack">
            <AnimatePresence>
              {groups.map((group, gi) => {
                const IconCmp = TYPE_ICON[group.type] || Icon.Doc;
                return (
                  <motion.div key={group.type} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: gi * 0.05 }}>
                    <Card title={<span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><IconCmp size={18} />{TYPE_LABELS[group.type] ?? group.type}</span>}
                      hint={`${group.count} result${group.count === 1 ? '' : 's'}`}>
                      <div className="rx-list">
                        {group.items.map((item) => {
                          const to = linkFor(item);
                          const label = item.label || item.title || item.name || item.id;
                          return (
                            <div className="rx-row" key={item.id}>
                              <div className="rx-row__main">
                                {to ? <Link to={to} className="rx-row__title" style={{ color: 'var(--rx-accent-strong)', textDecoration: 'none' }}>{label}</Link>
                                  : <span className="rx-row__title">{label}</span>}
                                {item.subtitle && <div className="rx-row__meta">{item.subtitle}</div>}
                              </div>
                              {to && <Icon.Arrow size={16} />}
                            </div>
                          );
                        })}
                      </div>
                    </Card>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
    </>
  );
}

export default SearchRedesign;
