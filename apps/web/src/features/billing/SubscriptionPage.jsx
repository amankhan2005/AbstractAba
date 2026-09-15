import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchMySubscription } from '@/api/client';
import { Badge, Card, Icon, ErrorState } from '@/ui';
import { formatDate } from '@/lib/format';
import {
  SUBSCRIPTION_STATUS_TONE, SUBSCRIPTION_STATUS_LABEL, countdownText, daysRemaining, periodProgress, limitLabel, formatSubscriptionPrice,
} from './subscription.jsx';

/**
 * Company Admin SUBSCRIPTION — the organization's real assigned SaaS package
 * (assigned by the platform administrator). Read-only and tenant-scoped:
 * GET /v1/billing/subscription serves only the caller's own organization.
 * Price and name are the subscription's own snapshot; description, features,
 * trial days and limits come from the package and are shown only when they
 * exist. Separate from Billing, which is insurance/clinical billing.
 *
 * Visual language is the Staff / Client / Sessions pages' own: the same page
 * header, cards, badges, empty and error states.
 */
export function SubscriptionPage() {
  const query = useQuery({ queryKey: ['my-subscription'], queryFn: fetchMySubscription });
  // Tick once a second so the countdown stays live; cheap and self-cleaning.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rx-sub">
      <header className="rx-st__head">
        <div className="rx-st__head-text">
          <h1 className="rx-st__title">Subscription</h1>
          <p className="rx-st__subtitle">Your organization’s assigned package, billing cycle and renewal.</p>
        </div>
      </header>

      {query.isLoading ? (
        <div className="rx-sub__skeleton" aria-busy="true" aria-label="Loading subscription">
          <div className="rx-skel" style={{ height: 190, borderRadius: 16 }} />
          <div className="rx-sub__grid"><div className="rx-skel" style={{ height: 200, borderRadius: 16 }} /><div className="rx-skel" style={{ height: 200, borderRadius: 16 }} /></div>
        </div>
      ) : query.isError ? (
        <Card pad={false}><ErrorState title="We couldn’t load your subscription" body="Please try again in a moment." onRetry={() => query.refetch()} /></Card>
      ) : !query.data ? (
        <Card pad={false}>
          <div className="rx-st__empty">
            <span className="rx-st__empty-icon" aria-hidden="true"><Icon.Wallet size={22} /></span>
            <div className="rx-st__empty-title">No active subscription</div>
            <p className="rx-st__empty-body">Your organization doesn’t currently have a subscription package. Contact your platform administrator to set one up.</p>
          </div>
        </Card>
      ) : <SubscriptionDetails sub={query.data} now={now} />}
    </div>
  );
}

function SubscriptionDetails({ sub, now }) {
  const status = sub.effectiveStatus ?? sub.status;
  const tone = SUBSCRIPTION_STATUS_TONE[status] ?? 'draft';
  const label = SUBSCRIPTION_STATUS_LABEL[status] ?? status;
  const yearly = sub.billingInterval === 'YEARLY';
  const cycle = yearly ? 'Annual' : 'Monthly';
  const per = yearly ? 'year' : 'month';
  const expired = status === 'EXPIRED' || sub.expired;
  const days = expired ? 0 : daysRemaining(sub.renewalDate, now);
  const countdown = expired ? null : countdownText(sub.renewalDate);
  const progress = periodProgress(sub.startDate, sub.renewalDate, now);
  const plan = sub.plan ?? null;
  const features = plan?.features ?? [];
  const limits = Object.entries(plan?.limits ?? {});
  const price = formatSubscriptionPrice(sub.amount);
  const packageName = sub.planName || plan?.name || 'Subscription package';

  return (
    <>
      <Card className="rx-sub__current" as="section">
        <div className="rx-sub__current-head">
          <div className="rx-st__who">
            <span className="rx-cl__stat-icon rx-sub__plan-icon" aria-hidden="true"><Icon.Sparkle size={18} /></span>
            <div className="rx-st__who-text">
              <div className="rx-cl__stat-label">Current plan</div>
              <h2 className="rx-sub__plan-name">{packageName}</h2>
              {plan?.description ? <p className="rx-sub__plan-desc">{plan.description}</p> : null}
            </div>
          </div>
          <div className="rx-sub__price" aria-label="Price">
            {price ? <><strong>{price}</strong><span>/ {per}</span></> : <span className="rx-st__muted">No price recorded</span>}
          </div>
        </div>
        <dl className="rx-sub__facts" aria-label="Current plan">
          <Fact label="Current package">{packageName}</Fact>
          <Fact label="Billing cycle">{cycle}</Fact>
          <Fact label="Price">{price ? `${price} / ${per}` : '—'}</Fact>
          <Fact label="Status"><Badge tone={tone}>{label}</Badge></Fact>
          <Fact label={expired ? 'End date' : 'Renewal date'}>{sub.renewalDate ? formatDate(sub.renewalDate) : '—'}</Fact>
          <Fact label="Remaining days">{days == null ? '—' : `${days} day${days === 1 ? '' : 's'}`}</Fact>
        </dl>
      </Card>

      <div className="rx-sub__grid">
        <Card title="Billing details" hint="The amount and billing period recorded for your organization">
          <dl className="rx-sub__rows" aria-label="Billing details">
            <Row label="Billing cycle">{cycle}</Row>
            <Row label="Amount">{price ? `${price} / ${per}` : '—'}</Row>
            <Row label="Current period start">{sub.startDate ? formatDate(sub.startDate) : '—'}</Row>
            <Row label={expired ? 'End date' : 'Renewal date'}>{sub.renewalDate ? formatDate(sub.renewalDate) : '—'}</Row>
            {plan?.trialDays > 0 ? <Row label="Package trial period">{plan.trialDays} day{plan.trialDays === 1 ? '' : 's'}</Row> : null}
            {sub.trialEnd ? <Row label="Trial ends">{formatDate(sub.trialEnd)}</Row> : null}
          </dl>
        </Card>

        <Card title="Subscription status" hint="Managed by your platform administrator">
          <div className="rx-sub__status">
            <div className="rx-sub__status-line">
              <Badge tone={tone}>{label}</Badge>
              <span>{expired ? 'This subscription has expired.' : countdown ? `Renews in ${countdown}` : sub.renewalDate ? '' : 'No renewal date is set.'}</span>
            </div>
            {progress != null && (
              <div className="rx-sub__period">
                <div className="rx-sub__period-bar" role="progressbar" aria-label="Billing period elapsed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                  <span className={`rx-sub__period-fill rx-sub__period-fill--${tone}`} style={{ width: `${progress}%` }} />
                </div>
                <div className="rx-sub__period-legend"><span>{formatDate(sub.startDate)}</span><span>{progress}% of period elapsed</span><span>{formatDate(sub.renewalDate)}</span></div>
              </div>
            )}
            {sub.cancelAtPeriodEnd && !expired ? <p className="rx-sub__notice">This subscription ends on {formatDate(sub.renewalDate)} and will not renew.</p> : null}
            {sub.canceledAt ? <p className="rx-st__muted rx-sub__text">Canceled on {formatDate(sub.canceledAt)}.</p> : null}
            <p className="rx-sub__note"><Icon.Building size={14} aria-hidden="true" /> Contact your platform administrator to change or renew your package.</p>
          </div>
        </Card>
      </div>

      {(features.length > 0 || limits.length > 0) && (
        <div className="rx-sub__grid">
          {features.length > 0 && (
            <Card title="Plan details" hint="Included in your package">
              <ul className="rx-sub__features" aria-label="Plan features">
                {features.map((f) => <li key={f}><Icon.CheckCircle size={15} aria-hidden="true" />{f}</li>)}
              </ul>
            </Card>
          )}
          {limits.length > 0 && (
            <Card title="Plan limits" hint="Defined by your package">
              <dl className="rx-sub__rows" aria-label="Plan limits">
                {limits.map(([k, v]) => <Row key={k} label={limitLabel(k)}>{typeof v === 'number' ? v.toLocaleString('en-US') : v}</Row>)}
              </dl>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

function Fact({ label, children }) {
  return <div className="rx-sub__fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Row({ label, children }) {
  return <div className="rx-sub__row"><dt>{label}</dt><dd>{children}</dd></div>;
}

export default SubscriptionPage;
