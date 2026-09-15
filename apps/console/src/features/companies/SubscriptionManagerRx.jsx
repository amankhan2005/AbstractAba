import { useState } from 'react';
import { DatePicker, todayIso } from '@aba1on1/date-picker';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchOrgSubscription, listPlans, assignSubscription, changeSubscriptionPackage,
  extendSubscription, updateSubscriptionValidity,
} from '@/api/client';
import {
  LoadingState, ErrorState, EmptyState, useToast, Modal, Card, Badge, Icon, Field, DescriptionList,
} from '@/components';
import { formatMoney } from '../billing/money.js';
import { formatDate } from '@/lib/format';
import { subscriptionStatus } from '@/lib/labels';

/**
 * Super Admin subscription management for one company (spec §7/§12/§13/§14).
 * Assign a package when there is none; change package, extend, or update
 * validity when there is one — each in its own dialog. All amounts, dates and
 * status come from the server; this panel only collects input and renders the
 * presented result.
 */
// Operator's calendar day (UTC `toISOString()` rolled to tomorrow in US evenings).
const todayISO = () => todayIso();
const planKey = (p) => p?._id ?? p?.id ?? '';

export function SubscriptionManagerRx({ organizationId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const sub = useQuery({ queryKey: ['org-subscription', organizationId], queryFn: () => fetchOrgSubscription(organizationId) });
  const plans = useQuery({ queryKey: ['plans', 'active'], queryFn: () => listPlans({ activeOnly: true }) });
  const [mode, setMode] = useState(null); // 'assign' | 'change' | 'extend' | 'validity'

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['org-subscription', organizationId] });
    qc.invalidateQueries({ queryKey: ['billing-overview'] });
  };
  const onErr = (e) => toast.push(e?.response?.data?.error?.message ?? 'The subscription couldn’t be updated. Please try again.', 'negative');

  const assign = useMutation({ mutationFn: (p) => assignSubscription({ organizationId, ...p }), onSuccess: () => { invalidate(); setMode(null); toast.push('Plan assigned.'); }, onError: onErr });
  const change = useMutation({ mutationFn: (p) => changeSubscriptionPackage({ organizationId, ...p }), onSuccess: () => { invalidate(); setMode(null); toast.push('Plan changed.'); }, onError: onErr });
  const extend = useMutation({ mutationFn: ({ id, endDate }) => extendSubscription(id, endDate), onSuccess: () => { invalidate(); setMode(null); toast.push('Subscription extended.'); }, onError: onErr });
  const validity = useMutation({ mutationFn: ({ id, ...p }) => updateSubscriptionValidity(id, p), onSuccess: () => { invalidate(); setMode(null); toast.push('Validity dates updated.'); }, onError: onErr });
  const busy = assign.isPending || change.isPending || extend.isPending || validity.isPending;

  if (sub.isLoading) return <Card><LoadingState label="Loading subscription…" /></Card>;
  if (sub.isError) return <Card><ErrorState message="The subscription couldn’t be loaded." onRetry={() => sub.refetch()} /></Card>;

  const s = sub.data; // presented shape or null
  const activePlans = plans.data ?? [];
  const close = () => { if (!busy) setMode(null); };

  if (!s) {
    return (
      <Card>
        <EmptyState
          icon="package"
          title="No subscription assigned"
          message="Assign a plan to start this company’s subscription."
          action={<button type="button" className="rxc-btn rxc-btn--primary rxc-btn--sm" onClick={() => setMode('assign')}><Icon name="plus" size={15} /><span>Assign plan</span></button>}
        />
        {mode === 'assign' && (
          <PlanDialog title="Assign plan" submitLabel="Assign plan" plans={activePlans} plansLoading={plans.isLoading} busy={busy}
            onCancel={close} onSubmit={(p) => assign.mutate(p)} />
        )}
      </Card>
    );
  }

  const st = subscriptionStatus(s.effectiveStatus);
  const yearly = s.billingInterval === 'YEARLY';
  const totalDays = yearly ? 365 : 30;
  const remainingPct = s.expired ? 0 : Math.max(0, Math.min(100, Math.round(((s.daysRemaining ?? 0) / totalDays) * 100)));
  const features = Array.isArray(s.plan?.features) ? s.plan.features : [];

  return (
    <div className="rxc-grid rxc-grid--main">
      <Card
        title="Current subscription"
        actions={(
          <div className="rxc-actions">
            <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => setMode('change')} disabled={busy}><Icon name="refresh" size={14} /><span>Change package</span></button>
            <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => setMode('extend')} disabled={busy}><Icon name="calendar" size={14} /><span>Extend</span></button>
            <button type="button" className="rxc-btn rxc-btn--secondary rxc-btn--sm" onClick={() => setMode('validity')} disabled={busy}><Icon name="edit" size={14} /><span>Update validity</span></button>
          </div>
        )}
      >
        <div className="rxc-sub-summary">
          <div className="rxc-sub-summary__plan">
            <span className="rxc-stat__icon rxc-tone--blue" style={{ width: 44, height: 44, borderRadius: 12 }}><Icon name="package" size={20} /></span>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 650, fontSize: '1.05rem' }}>{s.planName ?? 'Plan'}</span>
                <Badge tone={st.tone}>{st.label}</Badge>
              </div>
              <div className="rxc-muted" style={{ fontSize: '.82rem' }}>{yearly ? 'Billed annually' : 'Billed monthly'}</div>
            </div>
          </div>
          {s.amount != null ? (
            <div className="rxc-sub-summary__price">{formatMoney(s.amount, s.currency)} <small>/ {yearly ? 'year' : 'month'}</small></div>
          ) : null}
        </div>

        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem', marginBottom: 6 }}>
            <span className="rxc-muted">{s.expired ? 'Expired' : 'Time until renewal'}</span>
            <strong className="rxc-num">{s.expired ? 'Expired' : `${s.daysRemaining} day${s.daysRemaining === 1 ? '' : 's'}`}</strong>
          </div>
          <div className={`rxc-progress${s.expired ? ' rxc-progress--off' : st.tone === 'warn' ? ' rxc-progress--warn' : ''}`} aria-hidden="true">
            <span style={{ width: `${remainingPct}%` }} />
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <DescriptionList columns={2} items={[
            ['Started', s.startDate ? formatDate(s.startDate) : ''],
            [s.expired ? 'Expired on' : 'Renews on', s.renewalDate ? formatDate(s.renewalDate) : ''],
            ...(s.trialEnd && s.effectiveStatus === 'TRIALING' ? [['Trial ends', formatDate(s.trialEnd)]] : []),
            ...(s.canceledAt ? [['Canceled', formatDate(s.canceledAt)]] : []),
          ]} />
        </div>
      </Card>

      <Card title="Plan details">
        {s.plan ? (
          <div className="rxc-form">
            {s.plan.description ? <p className="rxc-plan__desc">{s.plan.description}</p> : null}
            <DescriptionList items={[
              ['Monthly price', s.plan.monthlyPrice != null ? formatMoney(s.plan.monthlyPrice, s.plan.currency) : ''],
              ['Annual price', s.plan.yearlyPrice != null ? formatMoney(s.plan.yearlyPrice, s.plan.currency) : ''],
              ['Trial period', s.plan.trialDays ? `${s.plan.trialDays} days` : 'None'],
            ]} />
            {features.length ? (
              <ul className="rxc-plan__features">
                {features.map((f) => <li key={f}><Icon name="check" size={14} />{f}</li>)}
              </ul>
            ) : null}
          </div>
        ) : <EmptyState compact icon="package" message="Plan details aren’t available." />}
      </Card>

      {mode === 'change' && (
        <PlanDialog title="Change package" description="The new package applies to this company’s subscription." submitLabel="Change package"
          plans={activePlans} plansLoading={plans.isLoading} busy={busy} currentPlanId={s.planId} currentInterval={s.billingInterval}
          onCancel={close} onSubmit={(p) => change.mutate(p)} />
      )}
      {mode === 'extend' && (
        <DateDialog title="Extend subscription" label="New expiration date" busy={busy} initial={s.renewalDate}
          onCancel={close} onSubmit={(endDate) => extend.mutate({ id: s.id, endDate })} />
      )}
      {mode === 'validity' && (
        <ValidityDialog busy={busy} start={s.startDate} end={s.renewalDate}
          onCancel={close} onSubmit={(p) => validity.mutate({ id: s.id, ...p })} />
      )}
    </div>
  );
}

function PlanDialog({ title, description, submitLabel, plans, plansLoading, busy, onCancel, onSubmit, currentPlanId, currentInterval }) {
  const [planId, setPlanId] = useState(currentPlanId && plans.some((p) => planKey(p) === currentPlanId) ? currentPlanId : planKey(plans[0]));
  const [billingInterval, setInterval] = useState(currentInterval ?? 'MONTHLY');
  const [startDate, setStart] = useState(todayISO());
  const [endDate, setEnd] = useState('');
  const [err, setErr] = useState('');
  const selected = plans.find((p) => planKey(p) === (planId || planKey(plans[0])));

  const submit = (e) => {
    e.preventDefault();
    const chosen = planId || planKey(plans[0]);
    if (!chosen) { setErr('Select a package.'); return; }
    if (endDate && startDate && endDate <= startDate) { setErr('The renewal date must be after the start date.'); return; }
    setErr('');
    // endDate is optional — the server computes it from the interval when blank.
    onSubmit({ planId: chosen, billingInterval, startDate, ...(endDate ? { endDate } : {}) });
  };

  return (
    <Modal title={title} description={description} onClose={onCancel} closeDisabled={busy}
      footer={<>
        <button type="button" className="rxc-btn rxc-btn--secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" form="rxc-plan-dialog" className="rxc-btn rxc-btn--primary" disabled={busy || plans.length === 0}>
          {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : null}
          <span>{busy ? 'Saving…' : submitLabel}</span>
        </button>
      </>}>
      <form id="rxc-plan-dialog" className="rxc-form" onSubmit={submit} noValidate>
        {!plansLoading && plans.length === 0 ? (
          <p className="rxc-alert rxc-alert--warn"><Icon name="alert" size={16} /><span>There are no active packages. Create or activate one in Plans &amp; billing first.</span></p>
        ) : null}
        <Field label="Package">
          <select value={planId} onChange={(e) => setPlanId(e.target.value)} disabled={plansLoading || plans.length === 0}>
            {plansLoading ? <option value="">Loading packages…</option> : null}
            {!plansLoading && plans.length === 0 ? <option value="">No active packages</option> : null}
            {plans.map((p) => <option key={planKey(p)} value={planKey(p)}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Subscription type">
          <select value={billingInterval} onChange={(e) => setInterval(e.target.value)}>
            <option value="MONTHLY">Monthly</option>
            <option value="YEARLY">Annual</option>
          </select>
        </Field>
        {selected ? (
          <p className="rxc-alert rxc-alert--info">
            <Icon name="info" size={16} />
            <span>{selected.name}: {formatMoney(billingInterval === 'YEARLY' ? selected.yearlyPrice : selected.monthlyPrice, selected.currency)} per {billingInterval === 'YEARLY' ? 'year' : 'month'}.</span>
          </p>
        ) : null}
        <div className="rxc-form-grid">
          <Field label="Start date">
            <DatePicker aria-label="Start date" value={startDate} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Renewal date" hint="Optional — calculated from the type if blank.">
            <DatePicker aria-label="Renewal date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        {err ? <p className="form-error" role="alert"><Icon name="alertCircle" size={16} /><span>{err}</span></p> : null}
      </form>
    </Modal>
  );
}

function DateDialog({ title, label, initial, busy, onCancel, onSubmit }) {
  const [value, setValue] = useState(initial ? String(initial).slice(0, 10) : todayISO());
  const [err, setErr] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (!value) { setErr('Choose a date.'); return; }
    onSubmit(value);
  };
  return (
    <Modal title={title} size="sm" onClose={onCancel} closeDisabled={busy}
      footer={<>
        <button type="button" className="rxc-btn rxc-btn--secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" form="rxc-date-dialog" className="rxc-btn rxc-btn--primary" disabled={busy}>
          {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : null}<span>{busy ? 'Saving…' : 'Save'}</span>
        </button>
      </>}>
      <form id="rxc-date-dialog" className="rxc-form" onSubmit={submit} noValidate>
        <Field label={label}>
          <DatePicker aria-label={label} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {err ? <p className="form-error" role="alert">{err}</p> : null}
      </form>
    </Modal>
  );
}

function ValidityDialog({ start, end, busy, onCancel, onSubmit }) {
  const [startDate, setStart] = useState(start ? String(start).slice(0, 10) : todayISO());
  const [endDate, setEnd] = useState(end ? String(end).slice(0, 10) : '');
  const [err, setErr] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (endDate && startDate && endDate <= startDate) { setErr('The renewal date must be after the start date.'); return; }
    setErr('');
    onSubmit({ startDate, ...(endDate ? { endDate } : {}) });
  };
  return (
    <Modal title="Update validity" description="Correct the start and renewal dates of this subscription." onClose={onCancel} closeDisabled={busy}
      footer={<>
        <button type="button" className="rxc-btn rxc-btn--secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" form="rxc-validity-dialog" className="rxc-btn rxc-btn--primary" disabled={busy}>
          {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : null}<span>{busy ? 'Saving…' : 'Save'}</span>
        </button>
      </>}>
      <form id="rxc-validity-dialog" className="rxc-form" onSubmit={submit} noValidate>
        <div className="rxc-form-grid">
          <Field label="Start date">
            <DatePicker aria-label="Start date" value={startDate} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Renewal date">
            <DatePicker aria-label="Renewal date" value={endDate} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        {err ? <p className="form-error" role="alert"><Icon name="alertCircle" size={16} /><span>{err}</span></p> : null}
      </form>
    </Modal>
  );
}

export default SubscriptionManagerRx;
