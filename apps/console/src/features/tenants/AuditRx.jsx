import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTenant, useTenantAudit } from '@/api/queries';
import { verifyTenantAudit } from '@/api/client';
import {
  PageHeader, Card, Badge, Icon, SearchInput, Pagination, EmptyState, ErrorState, SkeletonRows,
} from '@/components';
import { formatDateTime } from '@/lib/format';
import { auditAction, auditOutcome, humanizeCode } from '@/lib/labels';

/**
 * Company audit log — the recorded actions for one company in plain language,
 * with search, area and result filters, and an on-demand integrity check of the
 * tamper-evident audit chain (read-only API).
 */
const PAGE_SIZE = 25;

export function AuditRx() {
  const { id } = useParams();
  const org = useTenant(id);
  const audit = useTenantAudit(id);
  const [q, setQ] = useState('');
  const [outcome, setOutcome] = useState('');
  const [area, setArea] = useState('');
  const [page, setPage] = useState(0);
  const verify = useQuery({ queryKey: ['tenant-audit-verify', id], queryFn: () => verifyTenantAudit(id), enabled: false, retry: false });

  const all = useMemo(() => (Array.isArray(audit.data) ? audit.data : []), [audit.data]);
  const areas = useMemo(() => [...new Set(all.map((r) => auditAction(r.action).area).filter(Boolean))].sort(), [all]);
  const term = q.trim().toLowerCase();
  const rows = all.filter((r) => {
    const a = auditAction(r.action);
    if (outcome && r.outcome !== outcome) return false;
    if (area && a.area !== area) return false;
    if (!term) return true;
    return [a.action, a.area, humanizeCode(r.entityType), r.action].some((v) => (v || '').toLowerCase().includes(term));
  });
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shown = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const companyName = org.data?.tradingName;

  const v = verify.data;
  return (
    <section>
      <PageHeader
        back={{ to: `/companies/${id}`, label: companyName || 'Company' }}
        eyebrow={companyName || 'Company'}
        title="Audit log"
        description="Every recorded operator and system action for this company. Showing the most recent 100 entries."
        actions={(
          <button type="button" className="rxc-btn rxc-btn--secondary" onClick={() => verify.refetch()} disabled={verify.isFetching}>
            {verify.isFetching ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : <Icon name="shield" size={16} />}
            <span>{verify.isFetching ? 'Verifying…' : 'Verify integrity'}</span>
          </button>
        )}
      />

      {verify.isError ? (
        <p className="rxc-alert" role="alert" style={{ marginBottom: 16 }}><Icon name="alertCircle" size={16} /><span>The integrity check couldn’t be run. Please try again.</span></p>
      ) : v ? (
        v.ok
          ? <p className="rxc-alert rxc-alert--ok" role="status" style={{ marginBottom: 16 }}><Icon name="checkCircle" size={16} /><span>Audit chain verified — {v.checked} entr{v.checked === 1 ? 'y' : 'ies'} checked, no tampering detected.</span></p>
          : <p className="rxc-alert" role="alert" style={{ marginBottom: 16 }}><Icon name="alert" size={16} /><span>Integrity check failed at entry #{v.brokenAt} after {v.checked} verified entr{v.checked === 1 ? 'y' : 'ies'}. Escalate to the security team.</span></p>
      ) : null}

      <Card flush>
        <div className="rxc-toolbar">
          <SearchInput value={q} onChange={(val) => { setQ(val); setPage(0); }} placeholder="Search actions" label="Search audit log" />
          <span className="rxc-toolbar__spacer" />
          <label className="sr-only" htmlFor="audit-area">Filter by area</label>
          <select id="audit-area" className="rxc-select" value={area} onChange={(e) => { setArea(e.target.value); setPage(0); }}>
            <option value="">All areas</option>
            {areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <label className="sr-only" htmlFor="audit-outcome">Filter by result</label>
          <select id="audit-outcome" className="rxc-select" value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(0); }}>
            <option value="">All results</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </div>

        {audit.isLoading ? <SkeletonRows rows={8} label="Loading audit log" />
          : audit.isError ? <ErrorState message="The audit log couldn’t be loaded." onRetry={() => audit.refetch()} />
          : all.length === 0 ? <EmptyState icon="history" title="No audit entries yet" message="Actions taken for this company are recorded here." />
          : rows.length === 0 ? (
            <EmptyState icon="search" title="No matching entries" message="Try a different search or filter."
              action={<button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => { setQ(''); setOutcome(''); setArea(''); }}>Clear filters</button>} />
          ) : (
            <>
              <div className="rxc-table-wrap">
                <table className="rxc-table rxc-table--stack">
                  <caption className="sr-only">Audit log entries</caption>
                  <thead>
                    <tr><th scope="col">#</th><th scope="col">Action</th><th scope="col">Area</th><th scope="col">Record</th><th scope="col">Result</th><th scope="col">When</th></tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => {
                      const a = auditAction(r.action);
                      const out = auditOutcome(r.outcome);
                      return (
                        <tr key={r._id ?? r.id ?? r.sequence}>
                          <td data-label="Entry" className="is-muted rxc-num">{r.sequence}</td>
                          <td data-primary><span className="rxc-entity__name" style={{ whiteSpace: 'normal' }}>{a.action}</span></td>
                          <td data-label="Area">{a.area || '—'}</td>
                          <td data-label="Record">
                            <div>
                              <div>{humanizeCode(r.entityType) || '—'}</div>
                              {r.entityId != null ? <span className="rxc-table__sub" title={String(r.entityId)}>Ref …{String(r.entityId).slice(-8)}</span> : null}
                            </div>
                          </td>
                          <td data-label="Result"><Badge tone={out.tone}>{out.label}</Badge></td>
                          <td data-label="When" className="is-muted rxc-nowrap">{formatDateTime(r.occurredAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} noun="entries" />
            </>
          )}
      </Card>
    </section>
  );
}

export default AuditRx;
