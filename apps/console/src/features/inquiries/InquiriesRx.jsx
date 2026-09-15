import { useMemo, useState } from 'react';
import { useInquiries, useUpdateInquiry } from '@/api/queries';
import {
  LoadingState, ErrorState, EmptyState, Modal, useToast, PageHeader, Card, StatCard,
  Badge, Avatar, Icon, SearchInput, FilterTabs, Pagination, DescriptionList, Field,
} from '@/components';
import { formatDateTime } from '@/lib/format';

/**
 * Website inquiries — the messages sent through the public "Contact Us" page.
 * Platform operators read each inquiry, keep an optional internal note, and
 * track follow-up (New → Contacted → Closed). The API restricts every route
 * to platform operators; company users never reach this data.
 */
const PAGE_SIZE = 15;
export const INQUIRY_STATUS = {
  NEW: { label: 'New', tone: 'info' },
  CONTACTED: { label: 'Contacted', tone: 'warn' },
  CLOSED: { label: 'Closed', tone: 'ok' },
};
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'NEW', label: 'New' },
  { key: 'CONTACTED', label: 'Contacted' },
  { key: 'CLOSED', label: 'Closed' },
];

function StatusBadge({ status }) {
  const s = INQUIRY_STATUS[status] ?? { label: status, tone: 'neutral' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function InquiriesRx() {
  const { data, isLoading, isError, refetch } = useInquiries();
  const update = useUpdateInquiry();
  const toast = useToast();
  const [viewingId, setViewingId] = useState(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);

  const items = useMemo(() => (Array.isArray(data?.items) ? data.items : []), [data]);
  const counts = data?.counts ?? { NEW: 0, CONTACTED: 0, CLOSED: 0 };
  const term = search.trim().toLowerCase();
  const rows = items
    .filter((i) => status === 'all' || i.status === status)
    .filter((i) => !term || [i.name, i.organization, i.email, i.subject].some((v) => (v || '').toLowerCase().includes(term)));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shown = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const viewing = viewingId ? items.find((i) => i.id === viewingId) ?? null : null;

  async function save(inquiry, body, success) {
    try {
      await update.mutateAsync({ id: inquiry.id, body });
      toast.push(success);
      return true;
    } catch (e) {
      toast.push(e?.response?.data?.error?.message ?? 'The inquiry couldn’t be updated. Try again.', 'negative');
      return false;
    }
  }

  return (
    <section>
      <PageHeader
        eyebrow="Companies"
        title="Inquiries"
        description="Messages sent through the Abstract ABA website contact form. Review each inquiry and track follow-up."
      />

      {!isLoading && !isError ? (
        <div className="rxc-grid rxc-grid--stats" style={{ marginBottom: 20 }}>
          <StatCard icon="inbox" tone="blue" label="All inquiries" value={items.length} />
          <StatCard icon="sparkle" tone="violet" label="New" value={counts.NEW} hint="Awaiting a response" />
          <StatCard icon="send" tone="amber" label="Contacted" value={counts.CONTACTED} hint="Follow-up in progress" />
          <StatCard icon="checkCircle" tone="green" label="Closed" value={counts.CLOSED} />
        </div>
      ) : null}

      <Card flush>
        {isLoading ? <LoadingState label="Loading inquiries…" />
          : isError ? <ErrorState message="Inquiries couldn’t be loaded." onRetry={refetch} />
          : items.length === 0 ? (
            <EmptyState icon="inbox" title="No inquiries yet"
              message="Messages sent from the website contact page will appear here." />
          ) : (
            <>
              <div className="rxc-toolbar">
                <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0); }} placeholder="Search name, organization, email or subject" label="Search inquiries" />
                <FilterTabs label="Filter by status" value={status} onChange={(k) => { setStatus(k); setPage(0); }}
                  options={FILTERS.map((f) => ({ ...f, count: f.key === 'all' ? items.length : counts[f.key] ?? 0 }))} />
              </div>
              {rows.length === 0 ? (
                <EmptyState icon="search" title="No matching inquiries" message="Try a different search or status."
                  action={<button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => { setSearch(''); setStatus('all'); }}>Clear filters</button>} />
              ) : (
                <>
                  <div className="rxc-table-wrap">
                    <table className="rxc-table rxc-table--stack">
                      <caption className="sr-only">Website inquiries</caption>
                      <thead>
                        <tr>
                          <th scope="col">From</th>
                          <th scope="col">Subject</th>
                          <th scope="col">Submitted</th>
                          <th scope="col">Status</th>
                          <th scope="col"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((i) => (
                          <tr key={i.id}>
                            <td data-primary>
                              <div className="rxc-entity">
                                <Avatar name={i.name} size="md" />
                                <span className="rxc-entity__text">
                                  <span className="rxc-entity__name">{i.name}</span>
                                  <span className="rxc-entity__sub">{i.organization} · {i.email}</span>
                                </span>
                              </div>
                            </td>
                            <td data-label="Subject">{i.subject}</td>
                            <td data-label="Submitted" className="is-muted rxc-nowrap">{formatDateTime(i.createdAt) || '—'}</td>
                            <td data-label="Status"><StatusBadge status={i.status} /></td>
                            <td className="is-actions">
                              <div className="rxc-actions">
                                <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => setViewingId(i.id)} aria-label={`View inquiry from ${i.name}`}>
                                  <Icon name="eye" size={14} /><span>View</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} noun={rows.length === 1 ? 'inquiry' : 'inquiries'} />
                </>
              )}
            </>
          )}
      </Card>

      {viewing ? (
        <InquiryDetail
          inquiry={viewing}
          busy={update.isPending}
          onClose={() => setViewingId(null)}
          onStatus={(next) => save(viewing, { status: next }, next === 'CONTACTED' ? 'Marked as contacted.' : next === 'CLOSED' ? 'Inquiry closed.' : 'Inquiry reopened.')}
          onSaveNote={(note) => save(viewing, { internalNote: note.trim() ? note.trim() : null }, 'Internal note saved.')}
        />
      ) : null}
    </section>
  );
}

function InquiryDetail({ inquiry, busy, onClose, onStatus, onSaveNote }) {
  const [note, setNote] = useState(inquiry.internalNote ?? '');
  const noteChanged = note.trim() !== (inquiry.internalNote ?? '');

  return (
    <Modal
      title={inquiry.subject}
      description={`From ${inquiry.name}, ${inquiry.organization}`}
      onClose={onClose}
      size="lg"
      closeDisabled={busy}
      footer={<>
        <span className="modal-foot__start"><StatusBadge status={inquiry.status} /></span>
        {inquiry.status !== 'CLOSED' ? (
          <>
            {inquiry.status === 'NEW' ? (
              <button type="button" className="rxc-btn rxc-btn--secondary" onClick={() => onStatus('CONTACTED')} disabled={busy}>
                <Icon name="send" size={15} /><span>Mark contacted</span>
              </button>
            ) : null}
            <button type="button" className="rxc-btn rxc-btn--primary" onClick={() => onStatus('CLOSED')} disabled={busy}>
              <Icon name="checkCircle" size={15} /><span>Mark closed</span>
            </button>
          </>
        ) : (
          <button type="button" className="rxc-btn rxc-btn--secondary" onClick={() => onStatus('NEW')} disabled={busy}>
            <Icon name="refresh" size={15} /><span>Reopen</span>
          </button>
        )}
      </>}
    >
      <div className="rxc-form">
        <DescriptionList
          columns={2}
          items={[
            ['Full name', inquiry.name],
            ['Organization', inquiry.organization],
            ['Work email', <a key="email" className="rxc-inquiry-mail" href={`mailto:${inquiry.email}`}>{inquiry.email}</a>],
            ['Phone', inquiry.phone],
            ['Submitted', formatDateTime(inquiry.createdAt)],
            ['Status', INQUIRY_STATUS[inquiry.status]?.label ?? inquiry.status],
            inquiry.contactedAt ? ['Contacted', formatDateTime(inquiry.contactedAt)] : null,
            inquiry.closedAt ? ['Closed', formatDateTime(inquiry.closedAt)] : null,
          ]}
        />

        <div className="rxc-field">
          <span className="rxc-field__label">Message</span>
          <div className="rxc-inquiry-message">{inquiry.message}</div>
        </div>

        <Field label="Internal note" hint="Optional. Visible to platform administrators only.">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} placeholder="Add follow-up details for the team" />
        </Field>
        <div className="rxc-actions" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => onSaveNote(note)} disabled={busy || !noteChanged}>
            <Icon name="check" size={14} /><span>Save note</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default InquiriesRx;
