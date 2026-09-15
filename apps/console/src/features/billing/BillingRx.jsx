import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchBillingOverview, fetchPlans, fetchInvoices, fetchPayments, voidInvoice, updatePlan } from '@/api/client';
import { useAllTenants } from '@/api/queries';
import {
  PageHeader, Card, StatCard, Badge, Icon, Tabs, TabPanel, FilterTabs, SearchInput, Pagination,
  EmptyState, ErrorState, SkeletonRows, ConfirmDialog, useToast,
} from '@/components';
import { formatDate } from '@/lib/format';
import { invoiceStatus, paymentStatus, paymentMethodLabel } from '@/lib/labels';
import { formatMoney } from './money';
import { CreatePlanModal } from './CreatePlanModal';

/**
 * Plans & billing — platform revenue KPIs, subscription plan management
 * (create, edit, activate/deactivate) and the invoice and payment ledgers.
 * Real platform billing APIs; amounts are integer minor units formatted for
 * display only. Company names are resolved from the company directory.
 */
const PAGE_SIZE = 15;
const idOf = (x) => x?._id ?? x?.id ?? null;
const INVOICE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'OPEN', label: 'Open' },
  { key: 'PAID', label: 'Paid' },
  { key: 'VOID', label: 'Void' },
];

export function BillingRx() {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState('plans');
  const [voidTarget, setVoidTarget] = useState(null);
  const [planModal, setPlanModal] = useState(null); // null | { plan? }
  const [deactivating, setDeactivating] = useState(null);
  const [invoiceFilter, setInvoiceFilter] = useState('all');
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoicePage, setInvoicePage] = useState(0);
  const [paymentPage, setPaymentPage] = useState(0);

  const overview = useQuery({ queryKey: ['billing-overview'], queryFn: fetchBillingOverview });
  const plans = useQuery({ queryKey: ['billing-plans'], queryFn: fetchPlans });
  const invoices = useQuery({ queryKey: ['billing-invoices'], queryFn: () => fetchInvoices({}) });
  const payments = useQuery({ queryKey: ['billing-payments'], queryFn: () => fetchPayments({}) });
  const companies = useAllTenants();

  const companyName = useMemo(() => {
    const map = new Map((companies.data ?? []).map((c) => [c.id, c.tradingName || c.slug]));
    return (orgId) => map.get(orgId) ?? null;
  }, [companies.data]);
  const invoiceList = useMemo(() => (Array.isArray(invoices.data) ? invoices.data : []), [invoices.data]);
  const invoiceNumber = useMemo(() => {
    const map = new Map(invoiceList.map((i) => [idOf(i), i.invoiceNumber]));
    return (invId) => map.get(invId) ?? null;
  }, [invoiceList]);

  const doVoid = useMutation({
    mutationFn: (id) => voidInvoice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['billing-invoices'] });
      qc.invalidateQueries({ queryKey: ['billing-overview'] });
      setVoidTarget(null);
      toast.push('Invoice voided.');
    },
    onError: (e) => { toast.push(e?.response?.data?.error?.message ?? 'The invoice couldn’t be voided.', 'negative'); setVoidTarget(null); },
  });

  const togglePlan = useMutation({
    mutationFn: (p) => updatePlan(idOf(p), { active: !p.active }),
    onSuccess: (_d, p) => {
      qc.invalidateQueries({ queryKey: ['billing-plans'] });
      qc.invalidateQueries({ queryKey: ['plans'] });
      setDeactivating(null);
      toast.push(p.active ? `${p.name} deactivated.` : `${p.name} activated.`);
    },
    onError: (e) => { setDeactivating(null); toast.push(e?.response?.data?.error?.message ?? 'The plan couldn’t be updated.', 'negative'); },
  });

  const o = overview.data;
  const planList = [...(plans.data ?? [])].sort((a, b) => (b.active - a.active) || (a.monthlyPrice - b.monthlyPrice));
  const activePlans = planList.filter((p) => p.active).length;

  const invTerm = invoiceSearch.trim().toLowerCase();
  const invoiceRows = invoiceList
    .filter((i) => invoiceFilter === 'all' || i.status === invoiceFilter)
    .filter((i) => !invTerm || [i.invoiceNumber, companyName(i.organizationId)].some((v) => (v || '').toLowerCase().includes(invTerm)));
  const invoiceCounts = invoiceList.reduce((acc, i) => { acc[i.status] = (acc[i.status] ?? 0) + 1; return acc; }, { all: invoiceList.length });
  const invPages = Math.max(1, Math.ceil(invoiceRows.length / PAGE_SIZE));
  const invSafe = Math.min(invoicePage, invPages - 1);
  const paymentList = Array.isArray(payments.data) ? payments.data : [];
  const payPages = Math.max(1, Math.ceil(paymentList.length / PAGE_SIZE));
  const paySafe = Math.min(paymentPage, payPages - 1);

  const tabs = [
    { key: 'plans', label: 'Plans', icon: 'package', count: plans.isSuccess ? planList.length : null },
    { key: 'invoices', label: 'Invoices', icon: 'receipt', count: invoices.isSuccess ? invoiceList.length : null },
    { key: 'payments', label: 'Payments', icon: 'dollar', count: payments.isSuccess ? paymentList.length : null },
  ];

  return (
    <section>
      <PageHeader
        eyebrow="Business"
        title="Plans & billing"
        description="Subscription plans companies can be assigned, and the platform’s invoices and payments."
        actions={(
          <button type="button" className="rxc-btn rxc-btn--primary" onClick={() => setPlanModal({})}>
            <Icon name="plus" size={17} /><span>New plan</span>
          </button>
        )}
      />

      {overview.isError ? (
        <Card><ErrorState compact message="The billing overview couldn’t be loaded." onRetry={() => overview.refetch()} /></Card>
      ) : (
        <div className="rxc-grid rxc-grid--stats">
          <StatCard icon="trending" tone="green" label="Monthly recurring revenue" value={o ? formatMoney(o.mrr) : ''} loading={overview.isLoading} hint="Active subscriptions, monthly equivalent" />
          <StatCard icon="package" tone="blue" label="Active subscriptions" value={o?.activeSubscriptions ?? ''} loading={overview.isLoading} hint={o ? `${o.trialingCompanies ?? 0} in trial` : null} />
          <StatCard icon="clock" tone="amber" label="Past due" value={o?.pastDueCompanies ?? ''} loading={overview.isLoading} hint="Subscriptions awaiting payment" />
          <StatCard icon="receipt" tone="slate" label="Outstanding" value={o ? formatMoney(o.outstandingAmount) : ''} loading={overview.isLoading}
            hint={o ? `${o.outstandingInvoices} open invoice${o.outstandingInvoices === 1 ? '' : 's'}` : null} />
        </div>
      )}

      <div className="rxc-section">
        <Tabs tabs={tabs} value={tab} onChange={setTab} label="Billing sections" idBase="billing-tab" />

        {tab === 'plans' && (
          <TabPanel tabKey="plans" idBase="billing-tab">
            {plans.isLoading ? <Card><SkeletonRows rows={4} label="Loading plans" /></Card>
              : plans.isError ? <Card><ErrorState message="Plans couldn’t be loaded." onRetry={() => plans.refetch()} /></Card>
              : planList.length === 0 ? (
                <Card>
                  <EmptyState icon="package" title="No plans yet" message="Create the first plan companies can subscribe to."
                    action={<button type="button" className="rxc-btn rxc-btn--primary rxc-btn--sm" onClick={() => setPlanModal({})}><Icon name="plus" size={15} /><span>New plan</span></button>} />
                </Card>
              ) : (
                <>
                  <p className="rxc-muted" style={{ marginBottom: 12, fontSize: '.84rem' }}>
                    {activePlans} active · {planList.length - activePlans} inactive. Only active plans can be assigned to companies.
                  </p>
                  <div className="rxc-plans">
                    {planList.map((p) => (
                      <article className={`rxc-plan${p.active ? '' : ' is-inactive'}`} key={idOf(p) || p.code}>
                        <div className="rxc-plan__head">
                          <div>
                            <h3 className="rxc-plan__name">{p.name}</h3>
                            <div className="rxc-plan__code">{p.code}</div>
                          </div>
                          <Badge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'Active' : 'Inactive'}</Badge>
                        </div>
                        <div>
                          <div className="rxc-plan__price">{formatMoney(p.monthlyPrice, p.currency)} <small>/ month</small></div>
                          <div className="rxc-plan__alt">{formatMoney(p.yearlyPrice, p.currency)} / year{p.trialDays ? ` · ${p.trialDays}-day trial` : ''}</div>
                        </div>
                        {p.description ? <p className="rxc-plan__desc">{p.description}</p> : null}
                        {Array.isArray(p.features) && p.features.length ? (
                          <ul className="rxc-plan__features">
                            {p.features.slice(0, 5).map((f) => <li key={f}><Icon name="check" size={14} />{f}</li>)}
                          </ul>
                        ) : null}
                        <div className="rxc-plan__foot">
                          <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => setPlanModal({ plan: p })}>
                            <Icon name="edit" size={14} /><span>Edit</span>
                          </button>
                          {p.active ? (
                            <button type="button" className="rxc-btn rxc-btn--ghost rxc-btn--sm" disabled={togglePlan.isPending} onClick={() => setDeactivating(p)}>
                              <Icon name="power" size={14} /><span>Deactivate</span>
                            </button>
                          ) : (
                            <button type="button" className="rxc-btn rxc-btn--ghost rxc-btn--sm" disabled={togglePlan.isPending} onClick={() => togglePlan.mutate(p)}>
                              <Icon name="checkCircle" size={14} /><span>Activate</span>
                            </button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}
          </TabPanel>
        )}

        {tab === 'invoices' && (
          <TabPanel tabKey="invoices" idBase="billing-tab">
            <Card flush>
              <div className="rxc-toolbar">
                <SearchInput value={invoiceSearch} onChange={(v) => { setInvoiceSearch(v); setInvoicePage(0); }} placeholder="Search by invoice number or company" label="Search invoices" />
                <FilterTabs label="Filter invoices by status" value={invoiceFilter} onChange={(k) => { setInvoiceFilter(k); setInvoicePage(0); }}
                  options={INVOICE_FILTERS.map((f) => ({ ...f, count: invoices.isSuccess ? (invoiceCounts[f.key] ?? 0) : null }))} />
              </div>
              {invoices.isLoading ? <SkeletonRows rows={6} label="Loading invoices" />
                : invoices.isError ? <ErrorState message="Invoices couldn’t be loaded." onRetry={() => invoices.refetch()} />
                : invoiceList.length === 0 ? <EmptyState icon="receipt" title="No invoices yet" message="Invoices issued to companies appear here." />
                : invoiceRows.length === 0 ? (
                  <EmptyState icon="search" title="No matching invoices" message="Try a different search or status."
                    action={<button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => { setInvoiceSearch(''); setInvoiceFilter('all'); }}>Clear filters</button>} />
                ) : (
                  <>
                    <div className="rxc-table-wrap">
                      <table className="rxc-table rxc-table--stack">
                        <caption className="sr-only">Invoices</caption>
                        <thead>
                          <tr>
                            <th scope="col">Invoice</th><th scope="col">Company</th><th scope="col">Issued</th><th scope="col">Due</th>
                            <th scope="col" className="is-num">Total</th><th scope="col" className="is-num">Amount due</th><th scope="col">Status</th>
                            <th scope="col"><span className="sr-only">Actions</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {invoiceRows.slice(invSafe * PAGE_SIZE, (invSafe + 1) * PAGE_SIZE).map((i) => {
                            const st = invoiceStatus(i.status);
                            const name = companyName(i.organizationId);
                            return (
                              <tr key={idOf(i) ?? i.invoiceNumber}>
                                <td data-primary><span className="rxc-entity__name rxc-num">{i.invoiceNumber || 'Invoice'}</span></td>
                                <td data-label="Company">{name ? <Link to={`/companies/${i.organizationId}`}>{name}</Link> : <span className="rxc-muted">Unknown company</span>}</td>
                                <td data-label="Issued" className="is-muted rxc-nowrap">{formatDate(i.issuedAt ?? i.createdAt) || '—'}</td>
                                <td data-label="Due" className="is-muted rxc-nowrap">{formatDate(i.dueDate) || '—'}</td>
                                <td data-label="Total" className="is-num">{formatMoney(i.total, i.currency)}</td>
                                <td data-label="Amount due" className="is-num" style={{ fontWeight: i.amountDue > 0 ? 600 : 400 }}>{formatMoney(i.amountDue, i.currency)}</td>
                                <td data-label="Status"><Badge tone={st.tone}>{st.label}</Badge></td>
                                <td className="is-actions">
                                  {i.status === 'OPEN' ? (
                                    <button type="button" className="rxc-btn rxc-btn--danger-soft rxc-btn--sm" onClick={() => setVoidTarget(i)} aria-label={`Void invoice ${i.invoiceNumber ?? ''}`.trim()}>
                                      <Icon name="ban" size={14} /><span>Void</span>
                                    </button>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <Pagination page={invSafe} pageSize={PAGE_SIZE} total={invoiceRows.length} onPage={setInvoicePage} noun={invoiceRows.length === 1 ? 'invoice' : 'invoices'} />
                  </>
                )}
            </Card>
          </TabPanel>
        )}

        {tab === 'payments' && (
          <TabPanel tabKey="payments" idBase="billing-tab">
            <Card flush>
              {payments.isLoading ? <SkeletonRows rows={6} label="Loading payments" />
                : payments.isError ? <ErrorState message="Payments couldn’t be loaded." onRetry={() => payments.refetch()} />
                : paymentList.length === 0 ? <EmptyState icon="dollar" title="No payments yet" message="Payments recorded against invoices appear here." />
                : (
                  <>
                    <div className="rxc-table-wrap">
                      <table className="rxc-table rxc-table--stack">
                        <caption className="sr-only">Payments</caption>
                        <thead>
                          <tr>
                            <th scope="col">Date</th><th scope="col">Company</th><th scope="col">Invoice</th><th scope="col">Method</th>
                            <th scope="col">Reference</th><th scope="col" className="is-num">Amount</th><th scope="col">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paymentList.slice(paySafe * PAGE_SIZE, (paySafe + 1) * PAGE_SIZE).map((p) => {
                            const st = paymentStatus(p.status);
                            const name = companyName(p.organizationId);
                            return (
                              <tr key={idOf(p)}>
                                <td data-primary><span className="rxc-entity__name">{formatDate(p.paymentDate ?? p.createdAt)}</span></td>
                                <td data-label="Company">{name ? <Link to={`/companies/${p.organizationId}`}>{name}</Link> : <span className="rxc-muted">Unknown company</span>}</td>
                                <td data-label="Invoice" className="rxc-num">{invoiceNumber(p.invoiceId) ?? '—'}</td>
                                <td data-label="Method">{paymentMethodLabel(p.paymentMethod) || '—'}</td>
                                <td data-label="Reference" className="is-muted">{p.referenceNumber || '—'}</td>
                                <td data-label="Amount" className="is-num" style={{ fontWeight: 600 }}>{formatMoney(p.amount, p.currency)}</td>
                                <td data-label="Status"><Badge tone={st.tone}>{st.label}</Badge></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <Pagination page={paySafe} pageSize={PAGE_SIZE} total={paymentList.length} onPage={setPaymentPage} noun={paymentList.length === 1 ? 'payment' : 'payments'} />
                  </>
                )}
            </Card>
          </TabPanel>
        )}
      </div>

      <ConfirmDialog
        open={voidTarget !== null}
        title="Void invoice?"
        message={voidTarget ? `Invoice ${voidTarget.invoiceNumber ?? ''} for ${formatMoney(voidTarget.amountDue, voidTarget.currency)} will be voided. This can’t be undone.` : ''}
        confirmLabel="Void invoice"
        busyLabel="Voiding…"
        tone="danger"
        busy={doVoid.isPending}
        onConfirm={() => { const id = idOf(voidTarget); if (id) doVoid.mutate(id); }}
        onCancel={() => setVoidTarget(null)}
      />
      <ConfirmDialog
        open={deactivating !== null}
        title="Deactivate plan?"
        message={deactivating ? `${deactivating.name} will no longer be available to assign. Existing subscriptions on this plan aren’t changed.` : ''}
        confirmLabel="Deactivate plan"
        busyLabel="Deactivating…"
        tone="danger"
        busy={togglePlan.isPending}
        onConfirm={() => deactivating && togglePlan.mutate(deactivating)}
        onCancel={() => setDeactivating(null)}
      />

      {planModal ? <CreatePlanModal plan={planModal.plan ?? null} onClose={() => setPlanModal(null)} /> : null}
    </section>
  );
}

export default BillingRx;
