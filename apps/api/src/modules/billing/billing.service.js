import {
  SubscriptionPlan, Subscription, Invoice, InvoiceLineItem, Payment, CreditNote,
} from '../../models/index.js';
import { withPlatform } from '../../tenancy/tenantContext.js';
import { AppError } from '../../common/errors/AppError.js';
import { newId } from '../../utils/id.js';
import { computeInvoiceTotals, lineAmount, assertNonNegativeInt } from './money.js';
import { computeTax } from './tax.js';
import { recordSafely } from '../audit/audit.service.js';
import { presentSubscription } from './subscription.lifecycle.js';
import {
  assertSubscriptionTransition, assertInvoiceTransition, assertPaymentTransition,
} from './billing.state.js';

/** Super Admin package/plan actions are platform-global; audit them on their own chain. */
const PLATFORM_AUDIT_TENANT = '__platform__';

/**
 * Billing business logic. Platform↔company subscription billing, 100% manual —
 * there is no payment processor, gateway, or online payment path. All monetary
 * computation is server-side here; delivery/notification goes through the
 * injected jobQueue. Every mutation is invoked within withPlatform() because
 * these are operator-owned records keyed by organizationId (not tenant-plugin
 * rows), and every mutation is recorded to the hash-chained audit log.
 */
export class BillingService {
  constructor({ jobQueue } = {}) {
    this.jobQueue = jobQueue;
  }

  // ---- plans (operator) ----
  async createPlan(input, actorId) {
    assertNonNegativeInt(input.monthlyPrice, 'monthlyPrice');
    assertNonNegativeInt(input.yearlyPrice, 'yearlyPrice');
    return withPlatform(async () => {
      if (await SubscriptionPlan.findOne({ code: input.code.trim() })) {
        throw AppError.conflict('BILLING-409', 'A plan with that code already exists.');
      }
      const plan = await SubscriptionPlan.create({ ...input, code: input.code.trim(), createdBy: actorId });
      recordSafely({
        tenantId: PLATFORM_AUDIT_TENANT, actorId, action: 'billing.plan_created', entityType: 'subscription_plan', entityId: plan._id,
        outcome: 'success', payload: { code: plan.code, name: plan.name, monthlyPrice: plan.monthlyPrice, yearlyPrice: plan.yearlyPrice, active: plan.active },
      });
      return plan;
    });
  }

  async listPlans({ activeOnly = false } = {}) {
    return withPlatform(async () =>
      SubscriptionPlan.find(activeOnly ? { active: true } : {}).sort({ createdAt: -1 }).lean());
  }

  async updatePlan(id, patch, actorId) {
    if (patch.monthlyPrice != null) assertNonNegativeInt(patch.monthlyPrice, 'monthlyPrice');
    if (patch.yearlyPrice != null) assertNonNegativeInt(patch.yearlyPrice, 'yearlyPrice');
    return withPlatform(async () => {
      const plan = await SubscriptionPlan.findById(id);
      if (!plan) throw AppError.notFound('BILLING-404', 'Plan not found');
      const wasActive = plan.active;
      Object.assign(plan, patch, { updatedBy: actorId });
      await plan.save();
      if (patch.active !== undefined && patch.active !== wasActive) {
        recordSafely({
          tenantId: PLATFORM_AUDIT_TENANT, actorId, action: patch.active ? 'billing.plan_activated' : 'billing.plan_deactivated',
          entityType: 'subscription_plan', entityId: plan._id, outcome: 'success', payload: { active: plan.active },
        });
      }
      recordSafely({
        tenantId: PLATFORM_AUDIT_TENANT, actorId, action: 'billing.plan_updated', entityType: 'subscription_plan', entityId: plan._id,
        outcome: 'success', payload: { changed: Object.keys(patch) },
      });
      return plan.toObject();
    });
  }

  async setPlanActive(id, active, actorId) {
    return this.updatePlan(id, { active }, actorId);
  }

  // ---- subscriptions (operator) ----
  async getSubscriptionForOrg(organizationId) {
    return withPlatform(async () =>
      Subscription.findOne({ organizationId }).sort({ createdAt: -1 }).lean());
  }

  /**
   * The company's current subscription, shaped for display (spec §9/§23): the
   * snapshotted amount/name/type, the derived status (ACTIVE / EXPIRING_SOON /
   * EXPIRED / ...) and countdown data. Returns null for the empty state (§24).
   * The plan is loaded only to fill fields a pre-snapshot row is missing — it
   * never overrides a snapshot, so historical pricing is preserved (§28).
   */
  async getCurrentSubscription(organizationId, now = new Date()) {
    return withPlatform(async () => {
      const sub = await Subscription.findOne({ organizationId }).sort({ createdAt: -1 }).lean();
      if (!sub) return null;
      // The assigned package from the platform catalog. The subscription keeps its
      // own price/name SNAPSHOT (what this organization pays); the package adds its
      // real descriptive details for display. Additive — nothing is invented.
      const plan = sub.planId ? await SubscriptionPlan.findById(sub.planId).lean() : null;
      const snapshotPlan = (sub.unitAmount == null || sub.planName == null) ? plan : null;
      const presented = presentSubscription(sub, snapshotPlan, now);
      // Plan limits are shown only when the platform actually defined them:
      // plain numeric/text values, never defaults or guesses.
      const limits = plan?.limits && typeof plan.limits === 'object' && !Array.isArray(plan.limits)
        ? Object.fromEntries(Object.entries(plan.limits).filter(([, v]) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim())))
        : {};
      return {
        ...presented,
        trialStart: sub.trialStart ?? null,
        cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
        plan: plan ? {
          name: plan.name ?? null,
          description: plan.description ?? null,
          monthlyPrice: plan.monthlyPrice ?? null,
          yearlyPrice: plan.yearlyPrice ?? null,
          currency: plan.currency ?? presented.currency,
          trialDays: plan.trialDays ?? 0,
          features: Array.isArray(plan.features) ? plan.features.filter((f) => typeof f === 'string' && f.trim()) : [],
          limits,
        } : null,
      };
    });
  }

  /**
   * Resolve the validity window from the operator's input. Explicit dates win
   * (spec §8 "if the existing business logic allows Super Admin to explicitly
   * define validity dates, preserve that capability"); otherwise the end is
   * computed from the billing interval. The end must be after the start —
   * enforced here so no route can persist an inverted range (§8/§22).
   */
  static resolveValidity({ startDate, endDate, billingInterval }, now = new Date()) {
    const start = startDate ? new Date(startDate) : now;
    let end;
    if (endDate) {
      end = new Date(endDate);
    } else {
      end = new Date(start);
      if (billingInterval === 'YEARLY') end.setFullYear(end.getFullYear() + 1);
      else end.setMonth(end.getMonth() + 1);
    }
    if (!(end.getTime() > start.getTime())) {
      throw AppError.validation('The renewal/expiration date must be after the start date.');
    }
    return { start, end };
  }

  /** Snapshot the amount/name/currency for an interval off a plan (spec §28). */
  static snapshotOf(plan, billingInterval) {
    return {
      planName: plan.name,
      unitAmount: billingInterval === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice,
      currency: plan.currency ?? 'usd',
    };
  }

  async assignSubscription({ organizationId, planId, billingInterval = 'MONTHLY', startDate = null, endDate = null }, actorId) {
    return withPlatform(async () => {
      const plan = await SubscriptionPlan.findById(planId);
      if (!plan) throw AppError.notFound('BILLING-404', 'Plan not found');
      // An inactive package must not be assignable to a company (spec §6/§22).
      if (!plan.active) throw AppError.validation('That package is inactive and cannot be assigned.');
      // One current subscription per organization; historical CANCELED rows are
      // kept (spec §15). A live one blocks a second assignment.
      const existing = await Subscription.findOne({ organizationId, status: { $ne: 'CANCELED' } });
      if (existing) throw AppError.conflict('BILLING-409', 'Organization already has an active subscription.');

      const now = new Date();
      const { start, end } = BillingService.resolveValidity({ startDate, endDate, billingInterval }, now);
      const snap = BillingService.snapshotOf(plan, billingInterval);
      const trialEnd = (!startDate && !endDate && plan.trialDays > 0)
        ? new Date(now.getTime() + plan.trialDays * 86400000)
        : null;
      const sub = await Subscription.create({
        organizationId, planId, billingInterval, ...snap,
        status: trialEnd ? 'TRIALING' : 'ACTIVE',
        currentPeriodStart: start, currentPeriodEnd: end,
        trialStart: trialEnd ? now : null, trialEnd,
        createdBy: actorId,
      });
      recordSafely({
        tenantId: organizationId, actorId, action: 'billing.subscription_assigned', entityType: 'subscription', entityId: sub._id,
        outcome: 'success', payload: { planId, planName: snap.planName, amount: snap.unitAmount, billingInterval, status: sub.status, start, end },
      });
      return sub;
    });
  }

  /**
   * Change the package assigned to a company (spec §13). The current
   * subscription is canceled (kept for history — never overwritten) and a new
   * snapshotted subscription is created for the new package, so the change is
   * auditable and old pricing is preserved.
   */
  async changeSubscriptionPackage({ organizationId, planId, billingInterval = 'MONTHLY', startDate = null, endDate = null }, actorId) {
    return withPlatform(async () => {
      const plan = await SubscriptionPlan.findById(planId);
      if (!plan) throw AppError.notFound('BILLING-404', 'Plan not found');
      if (!plan.active) throw AppError.validation('That package is inactive and cannot be assigned.');
      const now = new Date();
      const { start, end } = BillingService.resolveValidity({ startDate, endDate, billingInterval }, now);
      const snap = BillingService.snapshotOf(plan, billingInterval);

      const current = await Subscription.findOne({ organizationId, status: { $ne: 'CANCELED' } });
      const fromPlanId = current?.planId ?? null;
      if (current) {
        current.status = 'CANCELED';
        current.canceledAt = now;
        current.updatedBy = actorId;
        await current.save();
      }
      const sub = await Subscription.create({
        organizationId, planId, billingInterval, ...snap,
        status: 'ACTIVE', currentPeriodStart: start, currentPeriodEnd: end, createdBy: actorId,
      });
      recordSafely({
        tenantId: organizationId, actorId, action: 'billing.subscription_package_changed', entityType: 'subscription', entityId: sub._id,
        outcome: 'success', payload: { fromPlanId, toPlanId: planId, previousSubscriptionId: current?._id ?? null, amount: snap.unitAmount, billingInterval },
      });
      return sub;
    });
  }

  /**
   * Extend a company's subscription to a later renewal/expiration date (spec §14).
   * The new end must be after the start; extending a canceled subscription is
   * refused. Reactivates an EXPIRED-but-ACTIVE row implicitly by moving the date.
   */
  async extendSubscription(subscriptionId, { endDate }, actorId) {
    return withPlatform(async () => {
      const sub = await Subscription.findById(subscriptionId);
      if (!sub) throw AppError.notFound('BILLING-404', 'Subscription not found');
      if (sub.status === 'CANCELED') throw AppError.conflict('BILLING-409', 'A canceled subscription cannot be extended.');
      const end = new Date(endDate);
      const start = sub.currentPeriodStart ? new Date(sub.currentPeriodStart) : new Date();
      if (!(end.getTime() > start.getTime())) {
        throw AppError.validation('The new expiration date must be after the start date.');
      }
      const previousEnd = sub.currentPeriodEnd;
      sub.currentPeriodEnd = end;
      sub.updatedBy = actorId;
      await sub.save();
      recordSafely({
        tenantId: sub.organizationId, actorId, action: 'billing.subscription_extended', entityType: 'subscription', entityId: sub._id,
        outcome: 'success', payload: { from: previousEnd, to: end },
      });
      return sub.toObject();
    });
  }

  /** Update a subscription's validity window explicitly (spec §12 "Update Validity"). */
  async updateSubscriptionValidity(subscriptionId, { startDate, endDate }, actorId) {
    return withPlatform(async () => {
      const sub = await Subscription.findById(subscriptionId);
      if (!sub) throw AppError.notFound('BILLING-404', 'Subscription not found');
      const start = startDate ? new Date(startDate) : (sub.currentPeriodStart ?? new Date());
      const end = endDate ? new Date(endDate) : sub.currentPeriodEnd;
      if (!end || !(end.getTime() > start.getTime())) {
        throw AppError.validation('The renewal/expiration date must be after the start date.');
      }
      const before = { start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
      sub.currentPeriodStart = start;
      sub.currentPeriodEnd = end;
      sub.updatedBy = actorId;
      await sub.save();
      recordSafely({
        tenantId: sub.organizationId, actorId, action: 'billing.subscription_validity_updated', entityType: 'subscription', entityId: sub._id,
        outcome: 'success', payload: { before, after: { start, end } },
      });
      return sub.toObject();
    });
  }

  async transitionSubscription(subscriptionId, target, actorId, extra = {}) {
    return withPlatform(async () => {
      const sub = await Subscription.findById(subscriptionId);
      if (!sub) throw AppError.notFound('BILLING-404', 'Subscription not found');
      const fromStatus = sub.status;
      assertSubscriptionTransition(sub.status, target);
      sub.status = target;
      if (target === 'CANCELED') { sub.canceledAt = new Date(); sub.cancelAtPeriodEnd = !!extra.atPeriodEnd; }
      sub.updatedBy = actorId;
      await sub.save();
      recordSafely({
        tenantId: sub.organizationId, actorId, action: 'billing.subscription_transitioned', entityType: 'subscription', entityId: sub._id,
        outcome: 'success', payload: { from: fromStatus, to: target },
      });
      return sub.toObject();
    });
  }

  // ---- invoices ----
  async generateInvoice({ organizationId, subscriptionId, lines, dueDate, generationKey }, actorId) {
    return withPlatform(async () => {
      if (generationKey) {
        const dupe = await Invoice.findOne({ generationKey });
        if (dupe) return dupe.toObject(); // idempotent
      }
      const computedLines = lines.map((l) => ({
        ...l, amount: lineAmount(l.quantity, l.unitAmount),
      }));
      const tax = computeTax({ organizationId, subtotal: computedLines.reduce((s, l) => s + l.amount, 0) });
      const totals = computeInvoiceTotals({ lines: computedLines, tax, creditsApplied: 0, amountPaid: 0 });
      const invoiceNumber = await this.nextInvoiceNumber();
      const invoice = await Invoice.create({
        organizationId, subscriptionId: subscriptionId ?? null, invoiceNumber,
        status: 'OPEN', ...totals, dueDate: dueDate ?? null, issuedAt: new Date(),
        generationKey: generationKey ?? null, createdBy: actorId,
      });
      await InvoiceLineItem.insertMany(computedLines.map((l) => ({
        invoiceId: invoice._id, organizationId, description: l.description,
        quantity: l.quantity, unitAmount: l.unitAmount, amount: l.amount,
        periodStart: l.periodStart ?? null, periodEnd: l.periodEnd ?? null, createdBy: actorId,
      })));
      if (this.jobQueue) {
        await this.jobQueue.enqueue({
          type: 'billing.notify', tenantId: null, actorId,
          payload: { event: 'invoice.generated', organizationId, invoiceId: invoice._id },
          idempotencyKey: `billing-notify:invoice.generated:${invoice._id}`,
        }).catch(() => {});
      }
      recordSafely({
        tenantId: organizationId, actorId, action: 'billing.invoice_generated', entityType: 'invoice', entityId: invoice._id,
        outcome: 'success', payload: { invoiceNumber: invoice.invoiceNumber, total: invoice.total },
      });
      return invoice.toObject();
    });
  }

  async nextInvoiceNumber() {
    // Monotonic, unique, human-readable: INV-YYYYMM-<count+1>. The unique index
    // on invoiceNumber is the real guarantee under concurrency.
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const count = await Invoice.countDocuments({ invoiceNumber: new RegExp(`^INV-${ym}-`) });
    return `INV-${ym}-${String(count + 1).padStart(5, '0')}`;
  }

  async listInvoices({ organizationId, status } = {}) {
    return withPlatform(async () => {
      const q = {};
      if (organizationId) q.organizationId = organizationId;
      if (status) q.status = status;
      return Invoice.find(q).sort({ createdAt: -1 }).lean();
    });
  }

  async getInvoice(id, { organizationId } = {}) {
    return withPlatform(async () => {
      const inv = await Invoice.findById(id).lean();
      if (!inv) throw AppError.notFound('BILLING-404', 'Invoice not found');
      // Tenant guard: a company may only read its own invoice.
      if (organizationId && inv.organizationId !== organizationId) {
        throw AppError.notFound('BILLING-404', 'Invoice not found');
      }
      const lines = await InvoiceLineItem.find({ invoiceId: id }).lean();
      return { ...inv, lines };
    });
  }

  async voidInvoice(id, actorId) {
    return withPlatform(async () => {
      const inv = await Invoice.findById(id);
      if (!inv) throw AppError.notFound('BILLING-404', 'Invoice not found');
      assertInvoiceTransition(inv.status, 'VOID');
      inv.status = 'VOID'; inv.voidedAt = new Date(); inv.amountDue = 0; inv.updatedBy = actorId;
      await inv.save();
      recordSafely({
        tenantId: inv.organizationId, actorId, action: 'billing.invoice_voided', entityType: 'invoice', entityId: inv._id,
        outcome: 'success', payload: { invoiceNumber: inv.invoiceNumber },
      });
      return inv.toObject();
    });
  }

  // ---- payments (manual) ----
  async recordPayment(
    { invoiceId, amount, paymentMethod = 'BANK_TRANSFER', referenceNumber = null, paymentDate = null, notes = null, organizationId: callerOrg = null },
    actorId,
  ) {
    assertNonNegativeInt(amount, 'amount');
    if (amount === 0) throw AppError.validation('Payment amount must be greater than zero.');
    return withPlatform(async () => {
      const inv = await Invoice.findById(invoiceId);
      if (!inv) throw AppError.notFound('BILLING-404', 'Invoice not found');
      // Tenant guard: when a company records its own payment, the invoice must
      // belong to it. Operators (no callerOrg) may record for any org.
      if (callerOrg && inv.organizationId !== callerOrg) {
        throw AppError.notFound('BILLING-404', 'Invoice not found');
      }
      if (inv.status === 'VOID') throw AppError.conflict('BILLING-409', 'Cannot pay a void invoice.');
      // Overpayment prevention: a payment may not exceed the remaining balance.
      if (amount > inv.amountDue) {
        throw AppError.validation(
          `Payment ${amount} exceeds the remaining balance ${inv.amountDue}. Record a payment up to the balance, or issue a credit.`,
        );
      }
      const payment = await Payment.create({
        organizationId: inv.organizationId, invoiceId, amount, currency: inv.currency,
        status: 'SUCCEEDED', paymentMethod, referenceNumber, notes,
        paymentDate: paymentDate ?? new Date(), recordedBy: actorId, createdBy: actorId,
      });
      inv.amountPaid = Math.min(inv.total, inv.amountPaid + amount);
      inv.amountDue = Math.max(0, inv.total - inv.amountPaid);
      if (inv.amountDue === 0) { assertInvoiceTransition(inv.status, 'PAID'); inv.status = 'PAID'; inv.paidAt = new Date(); }
      inv.updatedBy = actorId;
      await inv.save();
      if (this.jobQueue) {
        await this.jobQueue.enqueue({
          type: 'billing.notify', tenantId: null, actorId,
          payload: { event: 'payment.recorded', organizationId: inv.organizationId, invoiceId, paymentId: payment._id },
          idempotencyKey: `billing-notify:payment.recorded:${payment._id}`,
        }).catch(() => {});
      }
      recordSafely({
        tenantId: inv.organizationId, actorId, action: 'billing.payment_recorded', entityType: 'payment', entityId: payment._id,
        outcome: 'success', payload: { invoiceId, amount, paymentMethod },
      });
      return payment.toObject();
    });
  }

  async refundPayment(paymentId, actorId) {
    return withPlatform(async () => {
      const payment = await Payment.findById(paymentId);
      if (!payment) throw AppError.notFound('BILLING-404', 'Payment not found');
      assertPaymentTransition(payment.status, 'REFUNDED');
      payment.status = 'REFUNDED'; payment.updatedBy = actorId;
      await payment.save();
      recordSafely({
        tenantId: payment.organizationId, actorId, action: 'billing.payment_refunded', entityType: 'payment', entityId: payment._id,
        outcome: 'success', payload: { amount: payment.amount },
      });
      // Manual accounting: reverse the payment's effect on the invoice balance.
      const inv = await Invoice.findById(payment.invoiceId);
      if (inv && inv.status !== 'VOID') {
        inv.amountPaid = Math.max(0, inv.amountPaid - payment.amount);
        inv.amountDue = Math.max(0, inv.total - inv.amountPaid);
        if (inv.status === 'PAID' && inv.amountDue > 0) { inv.status = 'OPEN'; inv.paidAt = null; }
        inv.updatedBy = actorId;
        await inv.save();
      }
      return payment.toObject();
    });
  }

  async listPayments({ organizationId, status } = {}) {
    return withPlatform(async () => {
      const q = {};
      if (organizationId) q.organizationId = organizationId;
      if (status) q.status = status;
      return Payment.find(q).sort({ createdAt: -1 }).lean();
    });
  }

  // ---- credit notes ----
  async issueCredit({ organizationId, invoiceId = null, amount, reason }, actorId) {
    assertNonNegativeInt(amount, 'amount');
    return withPlatform(async () => {
      const credit = await CreditNote.create({ organizationId, invoiceId, amount, reason, createdBy: actorId });
      recordSafely({
        tenantId: organizationId, actorId, action: 'billing.credit_issued', entityType: 'credit_note', entityId: credit._id,
        outcome: 'success', payload: { invoiceId, amount },
      });
      return credit;
    });
  }

  async listCredits({ organizationId } = {}) {
    return withPlatform(async () =>
      CreditNote.find(organizationId ? { organizationId } : {}).sort({ createdAt: -1 }).lean());
  }

  // ---- tenant balance / summary ----
  async getBalance(organizationId) {
    return withPlatform(async () => {
      const open = await Invoice.find({ organizationId, status: { $in: ['OPEN', 'UNCOLLECTIBLE'] } }).lean();
      const outstanding = open.reduce((s, i) => s + i.amountDue, 0);
      return { organizationId, outstanding, openInvoiceCount: open.length };
    });
  }

  // ---- platform overview ----
  async overview() {
    return withPlatform(async () => {
      const [active, trialing, pastDue, openInvoices, plans] = await Promise.all([
        Subscription.countDocuments({ status: 'ACTIVE' }),
        Subscription.countDocuments({ status: 'TRIALING' }),
        Subscription.countDocuments({ status: 'PAST_DUE' }),
        Invoice.find({ status: 'OPEN' }).lean(),
        SubscriptionPlan.find({ active: true }).lean(),
      ]);
      // MRR: sum monthlyPrice of the plan for each ACTIVE subscription.
      const activeSubs = await Subscription.find({ status: 'ACTIVE' }).lean();
      const planById = new Map(plans.map((p) => [p._id, p]));
      const mrr = activeSubs.reduce((s, sub) => {
        const plan = planById.get(sub.planId);
        if (!plan) return s;
        return s + (sub.billingInterval === 'YEARLY' ? Math.round(plan.yearlyPrice / 12) : plan.monthlyPrice);
      }, 0);
      const outstanding = openInvoices.reduce((s, i) => s + i.amountDue, 0);
      return {
        mrr, activeSubscriptions: active, trialingCompanies: trialing, pastDueCompanies: pastDue,
        outstandingInvoices: openInvoices.length, outstandingAmount: outstanding,
      };
    });
  }
}
