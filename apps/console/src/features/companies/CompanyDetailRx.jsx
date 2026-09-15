import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { US_STATE_NAME_BY_CODE } from '@aba1on1/schemas';
import {
  useToast, LoadingState, ErrorState, EmptyState, ConfirmDialog, PageHeader, Card, Badge, Avatar, Icon,
  Tabs, TabPanel, DescriptionList, SkeletonRows,
} from '@/components';
import {
  useTenant, useMembers, useAgreements, useTenantAudit,
  useProvisionOrganization, useActivateOrganization, useTransitionOrganization,
} from '@/api/queries';
import { fetchOrgSubscription } from '@/api/client';
import { InviteOwnerModal } from './InviteOwnerModal';
import { SubscriptionManagerRx } from './SubscriptionManagerRx.jsx';
import { formatDate, formatDateTime, formatPersonName } from '@/lib/format';
import { companyStatus } from '@/lib/company-status';
import { memberRoles, memberStatus, auditAction, auditOutcome, subscriptionStatus, humanizeCode } from '@/lib/labels';
import { formatMoney } from '../billing/money.js';
import {
  companyActions, isVersionConflict, actionErrorMessage, VERSION_CONFLICT_MESSAGE,
} from '@/lib/company-actions';

/**
 * Company detail (Super Admin) — one company at a glance: identity hero with the
 * lifecycle action, then Overview / Subscription / Members / Agreements /
 * Activity tabs. It never shows raw lifecycle codes or concurrency mechanics;
 * every state-changing action confirms first, disables while working, and
 * preserves the backend's optimistic-concurrency version.
 */
const TABS = [
  { key: 'overview', label: 'Overview', icon: 'dashboard' },
  { key: 'subscription', label: 'Subscription', icon: 'card' },
  { key: 'members', label: 'Members', icon: 'users' },
  { key: 'agreements', label: 'Agreements', icon: 'file' },
  { key: 'activity', label: 'Activity', icon: 'history' },
];

function SubscriptionSummary({ organizationId, onManage }) {
  const sub = useQuery({ queryKey: ['org-subscription', organizationId], queryFn: () => fetchOrgSubscription(organizationId) });
  return (
    <Card title="Subscription" actions={<button type="button" className="rxc-link-btn" onClick={onManage}>Manage<Icon name="arrowRight" size={15} /></button>}>
      {sub.isLoading ? <SkeletonRows rows={2} label="Loading subscription" />
        : sub.isError ? <ErrorState compact message="The subscription couldn’t be loaded." onRetry={() => sub.refetch()} />
        : !sub.data ? (
          <EmptyState compact icon="package" title="No subscription" message="This company has no plan assigned yet."
            action={<button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={onManage}>Assign a plan</button>} />
        ) : (() => {
          const s = sub.data;
          const st = subscriptionStatus(s.effectiveStatus);
          return (
            <DescriptionList items={[
              ['Plan', <span key="p" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{s.planName ?? 'Plan'}<Badge tone={st.tone}>{st.label}</Badge></span>],
              ['Price', s.amount != null ? `${formatMoney(s.amount, s.currency)} / ${s.billingInterval === 'YEARLY' ? 'year' : 'month'}` : ''],
              [s.expired ? 'Expired on' : 'Renews on', formatDate(s.renewalDate)],
              ...(s.trialEnd && s.effectiveStatus === 'TRIALING' ? [['Trial ends', formatDate(s.trialEnd)]] : []),
            ]} />
          );
        })()}
    </Card>
  );
}

export function CompanyDetailRx() {
  const { id } = useParams();
  const toast = useToast();
  const org = useTenant(id);
  const members = useMembers(id);
  const agreements = useAgreements(id);
  const audit = useTenantAudit(id);
  const provision = useProvisionOrganization(id);
  const activate = useActivateOrganization(id);
  const transition = useTransitionOrganization(id);

  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState(null); // holds a companyActions() item
  const [tab, setTab] = useState('overview');

  const busy = activate.isPending || transition.isPending || provision.isPending;

  if (org.isLoading) return <LoadingState label="Loading company…" />;
  if (org.isError || org.data === undefined) {
    const notFound = org.error?.response?.status === 404;
    return (
      <section>
        <PageHeader back={{ to: '/companies', label: 'Companies' }} title={notFound ? 'Company not found' : 'Company'} />
        <Card>
          {notFound
            ? <EmptyState icon="building" title="This company doesn’t exist" message="It may have been removed, or the link is incorrect." action={<Link to="/companies" className="rxc-btn rxc-btn--secondary rxc-btn--sm">Back to companies</Link>} />
            : <ErrorState message="This company couldn’t be loaded." onRetry={() => org.refetch()} />}
        </Card>
      </section>
    );
  }
  const c = org.data;
  const status = companyStatus(c.state);
  const actions = companyActions(c);
  const memberRows = Array.isArray(members.data) ? members.data : [];
  const agreementRows = Array.isArray(agreements.data) ? agreements.data : [];
  const auditRows = Array.isArray(audit.data) ? audit.data : [];
  const location = [c.stateCode ? (US_STATE_NAME_BY_CODE[c.stateCode] ?? c.stateCode) : null, c.countryCode === 'US' ? 'United States' : c.countryCode].filter(Boolean).join(', ');

  async function runConfirmed(action) {
    if (busy) return; // guard against a double click before the button disables
    try {
      if (action.via === 'transition') {
        await transition.mutateAsync({ toState: action.toState, reason: action.reason, version: c.version });
        toast.push(action.toState === 'ACTIVE' ? 'Company activated.' : 'Company deactivated.');
      } else if (action.via === 'onboarding-activate') {
        await activate.mutateAsync(c.version);
        toast.push('Company activated.');
      } else if (action.via === 'provision') {
        await provision.mutateAsync();
        toast.push('Company setup started.');
      }
      setConfirm(null);
    } catch (err) {
      if (isVersionConflict(err)) {
        toast.push(VERSION_CONFLICT_MESSAGE, 'negative');
        org.refetch(); // pull the latest so the next attempt carries the current version
      } else {
        toast.push(actionErrorMessage(err), 'negative');
      }
      setConfirm(null);
    }
  }

  const tabs = TABS.map((t) => ({
    ...t,
    count: t.key === 'members' && members.isSuccess ? memberRows.length
      : t.key === 'agreements' && agreements.isSuccess ? agreementRows.length : null,
  }));

  return (
    <section>
      <Link to="/companies" className="rxc-back"><Icon name="arrowLeft" size={16} /><span>Companies</span></Link>

      <Card className="rxc-hero" as="div">
        <Avatar name={c.tradingName} src={c.logoUrl} size="lg" square />
        <div className="rxc-hero__text">
          <div className="rxc-hero__name">
            <h1>{c.tradingName}</h1>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          {c.legalName && c.legalName !== c.tradingName ? <div className="rxc-hero__sub">{c.legalName}</div> : null}
          <div className="rxc-hero__meta">
            {c.primaryContactEmail ? <span><Icon name="mail" size={14} />{c.primaryContactEmail}</span> : null}
            {location ? <span><Icon name="mapPin" size={14} />{location}</span> : null}
            <span><Icon name="calendar" size={14} />Created {formatDate(c.createdAt)}</span>
          </div>
        </div>
        <div className="rxc-hero__actions">
          <button type="button" className="rxc-btn rxc-btn--secondary" onClick={() => setInviting(true)} disabled={busy}>
            <Icon name="send" size={16} /><span>Invite owner</span>
          </button>
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              className={`rxc-btn ${a.tone === 'danger' ? 'rxc-btn--danger-soft' : a.tone === 'secondary' ? 'rxc-btn--secondary' : 'rxc-btn--primary'}`}
              onClick={() => (a.confirm ? setConfirm(a) : runConfirmed(a))}
              disabled={busy}
            >
              <Icon name={a.key === 'deactivate' ? 'power' : a.key === 'setup' ? 'sparkle' : 'checkCircle'} size={16} />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="rxc-section">
        <Tabs tabs={tabs} value={tab} onChange={setTab} label="Company sections" idBase="company-tab" />

        {tab === 'overview' && (
          <TabPanel tabKey="overview" idBase="company-tab">
            <div className="rxc-grid rxc-grid--main">
              <div className="rxc-stack">
                <Card title="Company details">
                  <DescriptionList items={[
                    ['Company name', c.tradingName],
                    ['Legal name', c.legalName],
                    ['Company ID (slug)', c.slug ? <span className="rxc-code">{c.slug}</span> : ''],
                    ['Location', location],
                    ['Time zone', c.timezone ? humanizeTimeZone(c.timezone) : ''],
                    ['Business agreement', c.agreementExecuted ? 'Signed' : 'Not signed'],
                  ]} />
                </Card>
                <Card title="Primary contact">
                  <DescriptionList items={[
                    ['Name', formatPersonName(c.primaryContactName)],
                    ['Email', c.primaryContactEmail ? <a href={`mailto:${c.primaryContactEmail}`}>{c.primaryContactEmail}</a> : ''],
                  ]} />
                </Card>
              </div>
              <div className="rxc-stack">
                <Card title="Account status">
                  <DescriptionList items={[
                    ['Status', <Badge key="s" tone={status.tone}>{status.label}</Badge>],
                    ['Created', formatDate(c.createdAt)],
                    ['Activated', formatDate(c.activatedAt)],
                    ...(c.offboardingAt ? [['Closing since', formatDate(c.offboardingAt)]] : []),
                  ]} />
                </Card>
                <SubscriptionSummary organizationId={id} onManage={() => setTab('subscription')} />
              </div>
            </div>
          </TabPanel>
        )}

        {tab === 'subscription' && (
          <TabPanel tabKey="subscription" idBase="company-tab">
            <SubscriptionManagerRx organizationId={id} />
          </TabPanel>
        )}

        {tab === 'members' && (
          <TabPanel tabKey="members" idBase="company-tab">
            <Card flush title="Members" description="People with access to this company’s panel.">
              {members.isLoading ? <SkeletonRows rows={5} label="Loading members" />
                : members.isError ? <ErrorState message="Members couldn’t be loaded." onRetry={() => members.refetch()} />
                : memberRows.length === 0 ? <EmptyState icon="users" title="No members yet" message="Members appear once the owner accepts their invitation." />
                : (
                  <div className="rxc-table-wrap">
                    <table className="rxc-table rxc-table--stack">
                      <caption className="sr-only">Company members</caption>
                      <thead><tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Joined</th><th scope="col">Last sign-in</th></tr></thead>
                      <tbody>
                        {memberRows.map((m) => {
                          const st = memberStatus(m.status);
                          const roles = memberRoles(m);
                          return (
                            <tr key={m.membershipId ?? m.userId ?? m.email}>
                              <td data-primary>
                                <div className="rxc-entity">
                                  <Avatar name={m.fullName || m.email} size="sm" />
                                  <span className="rxc-entity__text">
                                    <span className="rxc-entity__name">{formatPersonName(m.fullName) || m.email}</span>
                                    <span className="rxc-entity__sub">{m.email}</span>
                                  </span>
                                  {m.isOwner ? <Badge tone="info" dot={false}>Owner</Badge> : null}
                                </div>
                              </td>
                              <td data-label="Role">{roles.length ? roles.join(', ') : <span className="rxc-muted">—</span>}</td>
                              <td data-label="Status"><Badge tone={st.tone}>{st.label}</Badge></td>
                              <td data-label="Joined" className="is-muted rxc-nowrap">{formatDate(m.joinedAt) || '—'}</td>
                              <td data-label="Last sign-in" className="is-muted rxc-nowrap">{m.lastLoginAt ? formatDate(m.lastLoginAt) : 'Never'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </Card>
          </TabPanel>
        )}

        {tab === 'agreements' && (
          <TabPanel tabKey="agreements" idBase="company-tab">
            <Card flush title="Agreements" description="Signed agreements on file for this company.">
              {agreements.isLoading ? <SkeletonRows rows={3} label="Loading agreements" />
                : agreements.isError ? <ErrorState message="Agreements couldn’t be loaded." onRetry={() => agreements.refetch()} />
                : agreementRows.length === 0 ? <EmptyState icon="file" title="No agreements on file" message="Agreements signed during company setup appear here." />
                : (
                  <div className="rxc-table-wrap">
                    <table className="rxc-table rxc-table--stack">
                      <caption className="sr-only">Agreements</caption>
                      <thead><tr><th scope="col">Agreement</th><th scope="col">Signed by</th><th scope="col">Signed</th><th scope="col">Countersigned</th></tr></thead>
                      <tbody>
                        {agreementRows.map((a, i) => (
                          <tr key={a.id ?? i}>
                            <td data-primary>
                              <div className="rxc-entity">
                                <span className="rxc-stat__icon rxc-tone--slate"><Icon name="file" size={16} /></span>
                                <span className="rxc-entity__text">
                                  <span className="rxc-entity__name">{humanizeCode(a.type) || 'Agreement'}</span>
                                  {a.version ? <span className="rxc-entity__sub">Version {a.version}</span> : null}
                                </span>
                              </div>
                            </td>
                            <td data-label="Signed by">
                              <div>
                                <div>{formatPersonName(a.executedByName) || '—'}</div>
                                {a.executedByTitle ? <span className="rxc-table__sub">{a.executedByTitle}</span> : null}
                              </div>
                            </td>
                            <td data-label="Signed" className="is-muted rxc-nowrap">{formatDate(a.executedAt) || '—'}</td>
                            <td data-label="Countersigned">{a.countersignedAt ? formatDate(a.countersignedAt) : <Badge tone="warn">Awaiting</Badge>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </Card>
          </TabPanel>
        )}

        {tab === 'activity' && (
          <TabPanel tabKey="activity" idBase="company-tab">
            <Card flush title="Recent activity" description="The latest recorded actions for this company."
              actions={<Link to={`/companies/${id}/audit`} className="rxc-btn rxc-btn--secondary rxc-btn--sm"><Icon name="history" size={15} /><span>Full audit log</span></Link>}>
              {audit.isLoading ? <SkeletonRows rows={5} label="Loading activity" />
                : audit.isError ? <ErrorState message="Activity couldn’t be loaded." onRetry={() => audit.refetch()} />
                : auditRows.length === 0 ? <EmptyState icon="history" title="No activity yet" message="Actions taken for this company are recorded here." />
                : (
                  <div className="rxc-table-wrap">
                    <table className="rxc-table rxc-table--stack">
                      <caption className="sr-only">Recent activity</caption>
                      <thead><tr><th scope="col">Action</th><th scope="col">Area</th><th scope="col">Result</th><th scope="col">When</th></tr></thead>
                      <tbody>
                        {auditRows.slice(0, 10).map((r) => {
                          const act = auditAction(r.action);
                          const out = auditOutcome(r.outcome);
                          return (
                            <tr key={r._id ?? r.id ?? r.sequence}>
                              <td data-primary>
                                <span className="rxc-entity__name">{act.action}</span>
                                <span className="rxc-table__sub">{humanizeCode(r.entityType)}</span>
                              </td>
                              <td data-label="Area">{act.area || '—'}</td>
                              <td data-label="Result"><Badge tone={out.tone}>{out.label}</Badge></td>
                              <td data-label="When" className="is-muted rxc-nowrap">{formatDateTime(r.occurredAt)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </Card>
          </TabPanel>
        )}
      </div>

      {inviting && <InviteOwnerModal id={id} onClose={() => setInviting(false)} />}
      <ConfirmDialog
        open={!!confirm}
        tone={confirm?.tone}
        title={confirm?.confirm?.title}
        message={confirm?.confirm?.message}
        confirmLabel={confirm?.confirm?.confirmLabel}
        busy={busy}
        onConfirm={() => confirm && runConfirmed(confirm)}
        onCancel={() => { if (!busy) setConfirm(null); }}
      />
    </section>
  );
}

/** "America/Chicago" → "Central Time (America/Chicago)" for the zones companies use; otherwise the IANA id. */
const ZONE_NAMES = {
  'America/New_York': 'Eastern Time', 'America/Chicago': 'Central Time', 'America/Denver': 'Mountain Time',
  'America/Phoenix': 'Mountain Time (Arizona)', 'America/Los_Angeles': 'Pacific Time', 'America/Anchorage': 'Alaska Time',
  'Pacific/Honolulu': 'Hawaii Time',
};
function humanizeTimeZone(tz) {
  return ZONE_NAMES[tz] ? `${ZONE_NAMES[tz]} (${tz})` : tz;
}

export default CompanyDetailRx;
