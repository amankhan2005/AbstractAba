/**
 * ---------------------------------------------------------------------------
 * SUBSCRIPTION LIFECYCLE — derived status + renewal countdown (spec §10/§11/§25).
 *
 * The STORED status (subscription.model SUBSCRIPTION_STATUS) is the operator
 * lifecycle: TRIALING / ACTIVE / PAST_DUE / SUSPENDED / CANCELED. The company
 * Billing page additionally needs a time-derived view — EXPIRING_SOON when the
 * renewal date is near, EXPIRED once it has passed — which is a function of the
 * stored status and currentPeriodEnd, computed HERE so the backend stays the
 * source of truth (§11) and the frontend only formats what it is given.
 *
 * These are pure and time-injectable (`now`) so every boundary — expiry today,
 * month/year rollover, DST — is unit-tested without waiting for the clock.
 * ---------------------------------------------------------------------------
 */

/** A renewal within this many days reads as "expiring soon" (§11 threshold). */
export const EXPIRING_SOON_DAYS = 7;

const MS_PER_DAY = 86400000;

/** Milliseconds until renewal, floored at 0 — a countdown is never negative (§10). */
export function msRemaining(periodEnd, now = new Date()) {
  if (!periodEnd) return 0;
  const end = periodEnd instanceof Date ? periodEnd : new Date(periodEnd);
  const at = now instanceof Date ? now : new Date(now);
  return Math.max(0, end.getTime() - at.getTime());
}

/** Whole days/hours/minutes/seconds remaining, derived from the real timestamp. */
export function remainingBreakdown(periodEnd, now = new Date()) {
  const ms = msRemaining(periodEnd, now);
  const totalSeconds = Math.floor(ms / 1000);
  return {
    totalMs: ms,
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

/**
 * The effective, time-aware status for display.
 *
 * CANCELED / SUSPENDED / PAST_DUE are returned as-is — an operator lifecycle
 * state is authoritative over the clock. Otherwise a date-anchored subscription
 * whose end has passed is EXPIRED; one within the threshold is EXPIRING_SOON;
 * anything else keeps its stored status (ACTIVE or TRIALING).
 */
export function deriveEffectiveStatus(sub, now = new Date()) {
  if (!sub) return 'NONE';
  const stored = sub.status;
  if (stored === 'CANCELED') return 'CANCELED';
  if (stored === 'SUSPENDED') return 'SUSPENDED';
  if (stored === 'PAST_DUE') return 'PAST_DUE';

  const end = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  if (end) {
    const ms = end.getTime() - (now instanceof Date ? now : new Date(now)).getTime();
    if (ms <= 0) return 'EXPIRED';
    if (ms <= EXPIRING_SOON_DAYS * MS_PER_DAY) return 'EXPIRING_SOON';
  }
  return stored === 'TRIALING' ? 'TRIALING' : 'ACTIVE';
}

/**
 * Shape a stored subscription (a lean doc) for the API/UI: snapshot amount and
 * name where present (falling back to the live plan the caller passes in),
 * the derived status, and the countdown data. Returns null for "no subscription"
 * so the company Billing page can render its empty state (§24).
 *
 * @param sub   lean Subscription doc (or null)
 * @param plan  the live SubscriptionPlan (optional; only used to fill fields a
 *              pre-snapshot subscription is missing — never to override a
 *              snapshot, so historical pricing is preserved, §28)
 */
export function presentSubscription(sub, plan = null, now = new Date()) {
  if (!sub) return null;
  const interval = sub.billingInterval ?? 'MONTHLY';
  const unitAmount = sub.unitAmount != null
    ? sub.unitAmount
    : (plan ? (interval === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice) : null);
  const currency = sub.currency ?? plan?.currency ?? 'usd';
  const planName = sub.planName ?? plan?.name ?? null;
  const effectiveStatus = deriveEffectiveStatus(sub, now);
  const remaining = remainingBreakdown(sub.currentPeriodEnd, now);

  return {
    id: sub._id ?? sub.id,
    organizationId: sub.organizationId,
    planId: sub.planId,
    planName,
    amount: unitAmount,            // minor units, for `billingInterval`
    currency,
    billingInterval: interval,     // MONTHLY | YEARLY (subscription "type")
    status: sub.status,            // stored lifecycle status
    effectiveStatus,               // ACTIVE | EXPIRING_SOON | EXPIRED | TRIALING | ...
    startDate: sub.currentPeriodStart ?? null,
    renewalDate: sub.currentPeriodEnd ?? null,
    trialEnd: sub.trialEnd ?? null,
    canceledAt: sub.canceledAt ?? null,
    expired: effectiveStatus === 'EXPIRED',
    msRemaining: remaining.totalMs,
    daysRemaining: remaining.days,
    remaining,                     // { days, hours, minutes, seconds } for the countdown
  };
}
