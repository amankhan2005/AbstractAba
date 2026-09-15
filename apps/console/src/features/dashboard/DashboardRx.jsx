import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { fetchBillingOverview, listCompanyInvitations } from '@/api/client';
import { useAllTenants, useHealth } from '@/api/queries';
import { useAuthStore } from '@/auth/store';
import {
  PageHeader, Card, StatCard, Badge, Avatar, Icon, EmptyState, ErrorState, SkeletonRows,
} from '@/components';
import { formatDate } from '@/lib/format';
import { companyStatus } from '@/lib/company-status';
import { healthStatus, invitationStatus } from '@/lib/labels';
import { formatMoney } from '@/features/billing/money';
import { InviteCompanyWizard } from '@/features/companies/InviteCompanyWizard';
import { PLATFORM_BRAND } from '@aba1on1/schemas';

/**
 * Super Admin dashboard — platform overview built only from real console APIs:
 * the company directory, company invitations, the billing overview and the
 * platform health check. Every number links to the page that explains it.
 */
const GROUPS = [
  { key: 'active', label: 'Active', color: '#16a34a' },
  { key: 'pending', label: 'Pending invitation', color: '#3b82f6' },
  { key: 'deactivated', label: 'Deactivated', color: '#dc2626' },
  { key: 'other', label: 'Closing or closed', color: '#94a3b8' },
];

function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function StatusBreakdown({ groups, total }) {
  const entries = GROUPS.map((g) => ({ ...g, value: groups[g.key] ?? 0 })).filter((g) => g.value > 0);
  if (total === 0) return <EmptyState compact icon="building" title="No companies yet" message="Invite a company to see its status here." />;
  return (
    <>
      <div className="rxc-meter" role="img" aria-label={entries.map((e) => `${e.label}: ${e.value}`).join(', ')}>
        {entries.map((e) => <span key={e.key} style={{ width: `${(e.value / total) * 100}%`, background: e.color }} />)}
      </div>
      <ul className="rxc-legend">
        {GROUPS.map((g) => {
          const value = groups[g.key] ?? 0;
          if (g.key === 'other' && value === 0) return null;
          return (
            <li key={g.key}>
              <span className="rxc-legend__sw" style={{ background: g.color }} aria-hidden="true" />
              <span>{g.label}</span>
              <span className="rxc-legend__v">{value}</span>
              <span className="rxc-legend__pct">{Math.round((value / total) * 100)}%</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function DashboardRx() {
  const navigate = useNavigate();
  const principal = useAuthStore((s) => s.principal);
  const [inviting, setInviting] = useState(false);
  const companies = useAllTenants();
  const billing = useQuery({ queryKey: ['billing-overview'], queryFn: fetchBillingOverview });
  const invitations = useQuery({ queryKey: ['company-invitations', {}], queryFn: () => listCompanyInvitations({}) });
  const health = useHealth();

  const rows = Array.isArray(companies.data) ? companies.data : [];
  const groups = rows.reduce((acc, c) => { const g = companyStatus(c.state).group; acc[g] = (acc[g] ?? 0) + 1; return acc; }, {});
  const inviteRows = Array.isArray(invitations.data) ? invitations.data : [];
  const pendingInvites = inviteRows.filter((i) => i.status === 'PENDING');
  const recent = [...rows].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);
  const b = billing.data;
  const firstName = (principal?.user?.fullName || '').split(/\s+/)[0];
  const loadingCompanies = companies.isLoading;
  const h = health.data ? healthStatus(health.data.status) : null;

  return (
    <section>
      <PageHeader
        eyebrow="Platform overview"
        title={firstName ? `${greeting()}, ${firstName}` : 'Dashboard'}
        description={`Companies, subscriptions and platform status across ${PLATFORM_BRAND.productName}.`}
        actions={(
          <button type="button" className="rxc-btn rxc-btn--primary" onClick={() => setInviting(true)}>
            <Icon name="plus" size={17} /><span>Invite company</span>
          </button>
        )}
      />

      {companies.isError ? (
        <Card><ErrorState message="Company data couldn’t be loaded." onRetry={() => companies.refetch()} /></Card>
      ) : (
        <div className="rxc-grid rxc-grid--stats">
          <StatCard to="/companies" icon="building" tone="blue" label="Total companies" value={rows.length} loading={loadingCompanies}
            hint={loadingCompanies ? null : `${groups.active ?? 0} active`} />
          <StatCard to="/companies" icon="checkCircle" tone="green" label="Active companies" value={groups.active ?? 0} loading={loadingCompanies}
            hint={loadingCompanies || rows.length === 0 ? null : `${Math.round(((groups.active ?? 0) / rows.length) * 100)}% of all companies`} />
          <StatCard to="/companies/invitations" icon="mail" tone="violet" label="Pending invitations" value={pendingInvites.length} loading={invitations.isLoading}
            hint={invitations.isError ? 'Couldn’t load invitations' : 'Awaiting company setup'} />
          <StatCard to="/companies" icon="ban" tone="red" label="Deactivated" value={groups.deactivated ?? 0} loading={loadingCompanies}
            hint="Access currently turned off" />
        </div>
      )}

      <div className="rxc-section">
        <div className="rxc-page-head__row" style={{ marginBottom: 12 }}>
          <h2 className="rxc-section-title">Revenue &amp; subscriptions</h2>
          <Link to="/billing" className="rxc-link-btn">Open billing<Icon name="arrowRight" size={15} /></Link>
        </div>
        {billing.isError ? (
          <Card><ErrorState compact message="The billing overview couldn’t be loaded." onRetry={() => billing.refetch()} /></Card>
        ) : (
          <div className="rxc-grid rxc-grid--stats">
            <StatCard to="/billing" icon="trending" tone="green" label="Monthly recurring revenue" value={b ? formatMoney(b.mrr) : ''} loading={billing.isLoading} hint="From active subscriptions" />
            <StatCard to="/billing" icon="package" tone="blue" label="Active subscriptions" value={b?.activeSubscriptions ?? ''} loading={billing.isLoading}
              hint={b ? `${b.trialingCompanies ?? 0} in trial` : null} />
            <StatCard to="/billing" icon="clock" tone="amber" label="Past due" value={b?.pastDueCompanies ?? ''} loading={billing.isLoading} hint="Subscriptions awaiting payment" />
            <StatCard to="/billing" icon="receipt" tone="slate" label="Outstanding" value={b ? formatMoney(b.outstandingAmount) : ''} loading={billing.isLoading}
              hint={b ? `${b.outstandingInvoices} open invoice${b.outstandingInvoices === 1 ? '' : 's'}` : null} />
          </div>
        )}
      </div>

      <div className="rxc-grid rxc-grid--main rxc-section">
        <div className="rxc-stack">
          <Card
            flush
            title="Recently added companies"
            description="The newest companies on the platform."
            actions={<Link to="/companies" className="rxc-link-btn">View all<Icon name="arrowRight" size={15} /></Link>}
          >
            {loadingCompanies ? <SkeletonRows rows={5} label="Loading companies" />
              : recent.length === 0 ? (
                <EmptyState icon="building" title="No companies yet" message="Companies appear here once they are invited and set up."
                  action={<button type="button" className="rxc-btn rxc-btn--primary rxc-btn--sm" onClick={() => setInviting(true)}><Icon name="plus" size={15} /><span>Invite company</span></button>} />
              ) : (
                <div className="rxc-table-wrap">
                  <table className="rxc-table rxc-table--stack">
                    <thead><tr><th scope="col">Company</th><th scope="col">Status</th><th scope="col">Created</th></tr></thead>
                    <tbody>
                      {recent.map((c) => {
                        const st = companyStatus(c.state);
                        return (
                          <tr key={c.id}>
                            <td data-primary>
                              <Link to={`/companies/${c.id}`} className="rxc-entity">
                                <Avatar name={c.tradingName || c.slug} size="sm" square />
                                <span className="rxc-entity__text">
                                  <span className="rxc-entity__name">{c.tradingName || c.slug}</span>
                                  <span className="rxc-entity__sub">{c.primaryContactEmail || c.primaryContactName || '—'}</span>
                                </span>
                              </Link>
                            </td>
                            <td data-label="Status"><Badge tone={st.tone}>{st.label}</Badge></td>
                            <td data-label="Created" className="is-muted rxc-nowrap">{formatDate(c.createdAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>

          <Card
            title="Pending invitations"
            description="Companies that haven’t finished setting up yet."
            actions={<Link to="/companies/invitations" className="rxc-link-btn">Manage<Icon name="arrowRight" size={15} /></Link>}
          >
            {invitations.isLoading ? <SkeletonRows rows={3} label="Loading invitations" />
              : invitations.isError ? <ErrorState compact message="Invitations couldn’t be loaded." onRetry={() => invitations.refetch()} />
              : pendingInvites.length === 0 ? <EmptyState compact icon="mail" title="No pending invitations" message="Every invited company has responded." />
              : (
                <ul className="rxc-list">
                  {pendingInvites.slice(0, 5).map((inv) => {
                    const st = invitationStatus(inv.status);
                    return (
                      <li className="rxc-list__item" key={inv.id ?? inv.email}>
                        <Avatar name={inv.companyName || inv.email} size="sm" square />
                        <div className="rxc-list__main">
                          <div className="rxc-entity__name">{inv.companyName || inv.email}</div>
                          <div className="rxc-entity__sub">{inv.contactName ? `${inv.contactName} · ` : ''}{inv.email}</div>
                        </div>
                        <span className="rxc-list__meta">Expires {formatDate(inv.expiresAt)}</span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
          </Card>
        </div>

        <div className="rxc-stack">
          <Card title="Companies by status" description={loadingCompanies ? null : `${rows.length} compan${rows.length === 1 ? 'y' : 'ies'} in total`}>
            {loadingCompanies ? <SkeletonRows rows={3} label="Loading status breakdown" /> : <StatusBreakdown groups={groups} total={rows.length} />}
          </Card>

          <Card title="Platform status" actions={<Link to="/health" className="rxc-link-btn">Details<Icon name="arrowRight" size={15} /></Link>}>
            {health.isLoading ? <SkeletonRows rows={2} label="Checking platform status" />
              : health.isError || !h ? <ErrorState compact message="Platform status couldn’t be checked." onRetry={() => health.refetch()} />
              : (
                <div className="rxc-health-hero">
                  <span className={`rxc-health-hero__icon rxc-tone--${h.tone === 'ok' ? 'green' : 'amber'}`} style={{ width: 42, height: 42 }}>
                    <Icon name={h.tone === 'ok' ? 'checkCircle' : 'alert'} size={20} />
                  </span>
                  <div className="rxc-health-hero__text">
                    <div style={{ fontWeight: 650 }}>{h.tone === 'ok' ? 'All systems operational' : 'Some services need attention'}</div>
                    <div className="rxc-muted" style={{ fontSize: '.8rem' }}>
                      {(health.data.checks ?? []).length} service check{(health.data.checks ?? []).length === 1 ? '' : 's'} · Version {health.data.version}
                    </div>
                  </div>
                </div>
              )}
          </Card>

          <Card title="Quick actions">
            <div className="rxc-quick">
              <button type="button" className="rxc-quick__item" onClick={() => setInviting(true)}>
                <span className="rxc-quick__icon rxc-tone--blue"><Icon name="send" size={17} /></span>
                <span className="rxc-quick__text"><span className="rxc-quick__title">Invite a company</span><span className="rxc-quick__desc">Email a secure setup link to the owner</span></span>
                <Icon name="chevronRight" size={16} />
              </button>
              <button type="button" className="rxc-quick__item" onClick={() => navigate('/billing')}>
                <span className="rxc-quick__icon rxc-tone--green"><Icon name="package" size={17} /></span>
                <span className="rxc-quick__text"><span className="rxc-quick__title">Manage plans</span><span className="rxc-quick__desc">Create or update subscription plans</span></span>
                <Icon name="chevronRight" size={16} />
              </button>
              <button type="button" className="rxc-quick__item" onClick={() => navigate('/insurance')}>
                <span className="rxc-quick__icon rxc-tone--violet"><Icon name="shield" size={17} /></span>
                <span className="rxc-quick__text"><span className="rxc-quick__title">Insurance catalog</span><span className="rxc-quick__desc">Maintain state-specific insurers</span></span>
                <Icon name="chevronRight" size={16} />
              </button>
            </div>
          </Card>
        </div>
      </div>

      {inviting && <InviteCompanyWizard onClose={() => setInviting(false)} />}
    </section>
  );
}

export default DashboardRx;
