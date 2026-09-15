import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal, useToast, Field, Icon } from '@/components';
import { createPlan, updatePlan } from '@/api/client';

/**
 * Create OR edit a subscription plan (spec §14). Prices are entered in dollars
 * and converted to integer minor units (cents) before hitting the API — no
 * float money is sent. Passing a `plan` switches the modal to edit mode: the
 * code becomes read-only (it is the plan's stable identity) and the active flag
 * is editable. Both paths persist through the platform billing API and refresh
 * every plan query so the Billing page, the assignment picker and the company
 * directory all reflect the change immediately.
 *
 * The export name is kept as `CreatePlanModal` for backward compatibility with
 * existing callers; `PlanModal` is exposed as an alias.
 */
const centsToDollars = (c) => (c == null ? '' : (Number(c) / 100).toFixed(2));
const dollarsToCents = (v) => Math.round(Number(v) * 100);
const MONEY_RE = /^\d+(\.\d{1,2})?$/;

export function CreatePlanModal({ plan = null, onClose }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isEdit = Boolean(plan && (plan._id || plan.id));
  const planId = plan?._id ?? plan?.id ?? null;

  const [form, setForm] = useState({
    code: plan?.code ?? '',
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    monthly: centsToDollars(plan?.monthlyPrice),
    yearly: centsToDollars(plan?.yearlyPrice),
    currency: (plan?.currency ?? 'USD').toUpperCase(),
    trialDays: String(plan?.trialDays ?? 0),
    features: Array.isArray(plan?.features) ? plan.features.join('\n') : '',
    active: plan?.active ?? true,
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['billing-plans'] });
    qc.invalidateQueries({ queryKey: ['plans'] });
    qc.invalidateQueries({ queryKey: ['billing-overview'] });
  };

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() ? form.description.trim() : undefined,
        monthlyPrice: dollarsToCents(form.monthly),
        yearlyPrice: dollarsToCents(form.yearly),
        currency: form.currency.trim().toLowerCase() || undefined,
        trialDays: Number(form.trialDays) || 0,
        features: form.features.split('\n').map((f) => f.trim()).filter(Boolean),
      };
      if (isEdit) return updatePlan(planId, { ...body, active: form.active });
      return createPlan({ ...body, code: form.code.trim() });
    },
    onSuccess: () => { refresh(); toast.push(isEdit ? 'Plan updated.' : 'Plan created.'); onClose(); },
    onError: (err) => {
      const d = err?.response?.data?.error;
      const fe = d?.details?.fieldErrors;
      if (fe && Object.keys(fe).length) {
        const next = {};
        if (fe.code) next.code = fe.code[0];
        if (fe.name) next.name = fe.name[0];
        if (fe.monthlyPrice) next.monthly = fe.monthlyPrice[0];
        if (fe.yearlyPrice) next.yearly = fe.yearlyPrice[0];
        if (fe.currency) next.currency = fe.currency[0];
        if (fe.trialDays) next.trialDays = fe.trialDays[0];
        setErrors(next);
        if (Object.keys(next).length === 0) setFormError(Object.values(fe).flat().join(' '));
      } else {
        setFormError(d?.message ?? 'The plan couldn’t be saved. Please try again.');
      }
    },
  });
  const busy = mutation.isPending;

  function submit(e) {
    e?.preventDefault?.();
    if (busy) return;
    setFormError(null);
    const next = {};
    if (!isEdit && form.code.trim().length < 2) next.code = 'Enter a code of at least 2 characters.';
    if (form.name.trim().length < 2) next.name = 'Enter a name of at least 2 characters.';
    if (!MONEY_RE.test(String(form.monthly).trim())) next.monthly = 'Enter a price such as 99 or 99.00.';
    if (!MONEY_RE.test(String(form.yearly).trim())) next.yearly = 'Enter a price such as 990 or 990.00.';
    if (form.currency.trim().length !== 3) next.currency = 'Use a 3-letter code, such as USD.';
    const trial = Number(form.trialDays);
    if (!Number.isInteger(trial) || trial < 0 || trial > 365) next.trialDays = 'Enter a whole number from 0 to 365.';
    setErrors(next);
    if (Object.keys(next).length) return;
    mutation.mutate();
  }

  return (
    <Modal
      title={isEdit ? `Edit ${plan?.name ?? 'plan'}` : 'Create plan'}
      description={isEdit ? 'Update pricing, trial and availability. The plan code can’t be changed.' : 'Define a subscription plan companies can be assigned.'}
      onClose={onClose}
      size="lg"
      closeDisabled={busy}
      footer={
        <>
          <button type="button" className="rxc-btn rxc-btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="rxc-plan-form" className="rxc-btn rxc-btn--primary" disabled={busy}>
            {busy ? <span className="rxc-spinner rxc-spinner--inline" aria-hidden="true" /> : null}
            <span>{busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Create plan')}</span>
          </button>
        </>
      }
    >
      <form id="rxc-plan-form" className="rxc-form" onSubmit={submit} noValidate>
        {formError ? <p className="form-error" role="alert"><Icon name="alertCircle" size={16} /><span>{formError}</span></p> : null}

        <div className="rxc-form-section">
          <h3 className="rxc-form-section__title">Details</h3>
          <div className="rxc-form-grid">
            <Field label="Name" error={errors.name}>
              <input value={form.name} onChange={set('name')} placeholder="Professional" autoFocus aria-invalid={errors.name ? 'true' : undefined} />
            </Field>
            <Field label="Code" error={errors.code} hint={isEdit ? 'Fixed after creation.' : 'A short, unique identifier, e.g. PRO.'}>
              <input value={form.code} onChange={set('code')} placeholder="PRO" disabled={isEdit} readOnly={isEdit} aria-invalid={errors.code ? 'true' : undefined} />
            </Field>
            <Field label="Description" hint="Optional. Shown to operators when assigning plans." full>
              <textarea value={form.description} onChange={set('description')} placeholder="What this plan includes" rows={2} />
            </Field>
          </div>
        </div>

        <div className="rxc-form-section">
          <h3 className="rxc-form-section__title">Pricing</h3>
          <div className="rxc-form-grid">
            <Field label={`Monthly price (${form.currency || 'currency'})`} error={errors.monthly}>
              <input inputMode="decimal" value={form.monthly} onChange={set('monthly')} placeholder="99.00" aria-invalid={errors.monthly ? 'true' : undefined} />
            </Field>
            <Field label={`Annual price (${form.currency || 'currency'})`} error={errors.yearly}>
              <input inputMode="decimal" value={form.yearly} onChange={set('yearly')} placeholder="990.00" aria-invalid={errors.yearly ? 'true' : undefined} />
            </Field>
            <Field label="Currency" error={errors.currency}>
              <input value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) }))} placeholder="USD" maxLength={3} aria-invalid={errors.currency ? 'true' : undefined} />
            </Field>
            <Field label="Trial days" error={errors.trialDays} hint="0 for no trial.">
              <input type="number" inputMode="numeric" min="0" max="365" value={form.trialDays} onChange={set('trialDays')} aria-invalid={errors.trialDays ? 'true' : undefined} />
            </Field>
          </div>
        </div>

        <div className="rxc-form-section">
          <h3 className="rxc-form-section__title">Features &amp; availability</h3>
          <Field label="Features" hint="Optional. One feature per line.">
            <textarea value={form.features} onChange={set('features')} placeholder={'Up to 25 staff\nInsurance billing'} rows={3} />
          </Field>
          <label className="rxc-switch">
            <span className="rxc-switch__text">
              <span className="rxc-switch__title">Available to assign</span>
              <span className="rxc-switch__desc">Inactive plans stay on existing subscriptions but can’t be assigned.</span>
            </span>
            <input type="checkbox" role="switch" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} disabled={!isEdit} />
          </label>
        </div>
      </form>
    </Modal>
  );
}

export const PlanModal = CreatePlanModal;
export default CreatePlanModal;
