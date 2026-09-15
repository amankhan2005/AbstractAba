import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCompanyInvitations, useResendCompanyInvitation, useRevokeCompanyInvitation } from '@/api/queries';
import {
  PageHeader, Card, Badge, Avatar, Icon, SearchInput, FilterTabs, Pagination,
  EmptyState, ErrorState, SkeletonRows, ConfirmDialog, useToast,
} from '@/components';
import { formatDate, formatDateTime } from '@/lib/format';
import { invitationStatus } from '@/lib/labels';
import { InviteCompanyWizard } from './InviteCompanyWizard';

/**
 * Company invitations — every onboarding invite with its status and expiry,
 * searchable and filterable, with Resend (pending or expired) and Revoke
 * (pending or expired, confirmed first). Real console API; the single
 * InviteCompanyWizard is used for sending.
 */
const PAGE_SIZE = 15;
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'ACCEPTED', label: 'Accepted' },
  { key: 'EXPIRED', label: 'Expired' },
  { key: 'REVOKED', label: 'Revoked' },
];
const idOf = (inv) => inv?.id ?? inv?._id ?? null;

export function InvitationsRx() {
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [resendingId, setResendingId] = useState(null);
  const { data, isLoading, isError, refetch } = useCompanyInvitations();
  const resend = useResendCompanyInvitation();
  const revoke = useRevokeCompanyInvitation();
  const toast = useToast();

  const all = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const counts = useMemo(() => all.reduce((acc, i) => { acc[i.status] = (acc[i.status] ?? 0) + 1; return acc; }, { all: all.length }), [all]);
  const term = search.trim().toLowerCase();
  const rows = all
    .filter((i) => filter === 'all' || i.status === filter)
    .filter((i) => !term || [i.email, i.companyName, i.contactName].some((v) => (v || '').toLowerCase().includes(term)));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shown = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  async function doResend(inv) {
    const id = idOf(inv);
    if (!id || resendingId) return;
    setResendingId(id);
    try { await resend.mutateAsync(id); toast.push(`Invitation re-sent to ${inv.email}.`); }
    catch (e) { toast.push(e?.response?.data?.error?.message ?? 'The invitation couldn’t be resent.', 'negative'); }
    finally { setResendingId(null); }
  }
  async function doRevoke() {
    const id = idOf(revoking);
    if (!id) { setRevoking(null); return; }
    try { await revoke.mutateAsync(id); toast.push('Invitation revoked.'); setRevoking(null); }
    catch (e) { toast.push(e?.response?.data?.error?.message ?? 'The invitation couldn’t be revoked.', 'negative'); setRevoking(null); }
  }

  return (
    <section>
      <PageHeader
        back={{ to: '/companies', label: 'Companies' }}
        title="Invitations"
        description="Track company invitations, resend links that haven’t been used, or revoke them."
        actions={(
          <button type="button" className="rxc-btn rxc-btn--primary" onClick={() => setInviting(true)}>
            <Icon name="plus" size={17} /><span>Invite company</span>
          </button>
        )}
      />

      <Card flush>
        <div className="rxc-toolbar">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0); }} placeholder="Search by company, contact or email" label="Search invitations" />
          <FilterTabs label="Filter by status" value={filter} onChange={(k) => { setFilter(k); setPage(0); }}
            options={FILTERS.map((f) => ({ ...f, count: isLoading ? null : (counts[f.key] ?? 0) }))} />
        </div>

        {isLoading ? <SkeletonRows rows={6} label="Loading invitations" />
          : isError ? <ErrorState message="Invitations couldn’t be loaded." onRetry={() => refetch()} />
          : all.length === 0 ? (
            <EmptyState icon="mail" title="No invitations yet" message="Invite a company and its owner will receive a secure setup link."
              action={<button type="button" className="rxc-btn rxc-btn--primary rxc-btn--sm" onClick={() => setInviting(true)}><Icon name="plus" size={15} /><span>Invite company</span></button>} />
          ) : rows.length === 0 ? (
            <EmptyState icon="search" title="No matching invitations" message="Try a different search term or status."
              action={<button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => { setSearch(''); setFilter('all'); }}>Clear filters</button>} />
          ) : (
            <>
              <div className="rxc-table-wrap">
                <table className="rxc-table rxc-table--stack">
                  <caption className="sr-only">Company invitations</caption>
                  <thead>
                    <tr>
                      <th scope="col">Company</th>
                      <th scope="col">Contact</th>
                      <th scope="col">Status</th>
                      <th scope="col">Sent</th>
                      <th scope="col">Expires</th>
                      <th scope="col"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((inv) => {
                      const st = invitationStatus(inv.status);
                      const actionable = inv.status === 'PENDING' || inv.status === 'EXPIRED';
                      const id = idOf(inv);
                      return (
                        <tr key={id ?? inv.email}>
                          <td data-primary>
                            <div className="rxc-entity">
                              <Avatar name={inv.companyName || inv.email} size="md" square />
                              <span className="rxc-entity__text">
                                {inv.organizationId
                                  ? <Link to={`/companies/${inv.organizationId}`} className="rxc-entity__name">{inv.companyName || 'Company'}</Link>
                                  : <span className="rxc-entity__name">{inv.companyName || 'Company name not provided'}</span>}
                              </span>
                            </div>
                          </td>
                          <td data-label="Contact">
                            <div>
                              <div style={{ fontWeight: 550 }}>{inv.contactName || '—'}</div>
                              <span className="rxc-table__sub">{inv.email}</span>
                            </div>
                          </td>
                          <td data-label="Status"><Badge tone={st.tone}>{st.label}</Badge></td>
                          <td data-label="Sent" className="is-muted rxc-nowrap">{formatDate(inv.createdAt) || '—'}</td>
                          <td data-label="Expires" className="is-muted rxc-nowrap" title={inv.expiresAt ? formatDateTime(inv.expiresAt) : undefined}>
                            {inv.status === 'ACCEPTED' || inv.status === 'REVOKED' ? '—' : (formatDate(inv.expiresAt) || '—')}
                          </td>
                          <td className="is-actions">
                            {actionable ? (
                              <div className="rxc-actions">
                                <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => doResend(inv)} disabled={!!resendingId} aria-label={`Resend invitation to ${inv.email}`}>
                                  {resendingId === id ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : <Icon name="send" size={14} />}
                                  <span>{resendingId === id ? 'Sending…' : 'Resend'}</span>
                                </button>
                                <button type="button" className="rxc-btn rxc-btn--danger-soft rxc-btn--sm" onClick={() => setRevoking(inv)} disabled={revoke.isPending} aria-label={`Revoke invitation for ${inv.email}`}>
                                  <Icon name="ban" size={14} /><span>Revoke</span>
                                </button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} noun={rows.length === 1 ? 'invitation' : 'invitations'} />
            </>
          )}
      </Card>

      {inviting && <InviteCompanyWizard onClose={() => setInviting(false)} />}
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke invitation?"
        message={revoking ? `${revoking.email} will no longer be able to use this invitation link. You can send a new invitation later.` : ''}
        confirmLabel="Revoke invitation"
        busyLabel="Revoking…"
        tone="danger"
        busy={revoke.isPending}
        onConfirm={doRevoke}
        onCancel={() => setRevoking(null)}
      />
    </section>
  );
}

export default InvitationsRx;
